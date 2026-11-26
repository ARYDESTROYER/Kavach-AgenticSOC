/**
 * CaseDetail while an AI investigation runs on the case, and the signal event count
 * (Round 16, WP16 integration):
 *
 * - Take action's Reinvestigate is unavailable while a run is queued or running: it says
 *   "An AI investigation is already running." in the reading order, choosing it opens no
 *   dialog, and R does nothing (a second run would only be refused);
 * - the header's verdict chip is the verdict the run replaces: dimmed, its label word
 *   dropped, named "Previous verdict" for assistive technology, and its hover line leads
 *   with "Previous verdict. The running investigation replaces it.";
 * - the run chip keeps its words ("AI working · 0:38", then "AI finished") on every
 *   measured strip of 30rem or wider, the 779px strip of Case Manager at 1440 by 900
 *   among them, and its mark with the word "AI" below 30rem (XFCM, FXB);
 * - the Signal section's event count opens the Evidence tab.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { InvestigationView } from '@/lib/types';

const h = vi.hoisted(() => ({
  run: null as InvestigationView | null,
  finished: null as { view: InvestigationView; at: number; active: boolean; shown: boolean } | null,
}));

const CASE = {
  case_id: 'c-run-1',
  case_number: 'CASE-2026-0500',
  title: 'Password spray against the VPN',
  status: 'investigating',
  verdict: 'NEEDS_HUMAN',
  confidence: 0.55,
  risk_score: 55,
  severity_band: 'high',
  member_event_ids: ['e-1', 'e-2', 'e-3'],
  updated_at: '2026-10-10T10:00:00Z',
  created_at: '2026-10-10T09:00:00Z',
  history: [],
};

vi.mock('@/lib/api', () => {
  const target: Record<string, unknown> = {
    getCase: vi.fn(() => Promise.resolve(CASE)),
  };
  class ApiError extends Error {
    status = 500;
  }
  return {
    ApiError,
    api: new Proxy(target, {
      get: (t, prop) => {
        if (prop === 'then') return undefined;
        if (!(prop in t)) t[prop as string] = vi.fn(() => Promise.resolve({}));
        return t[prop as string];
      },
    }),
  };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ username: 'probe', hasPermission: () => true, user: null }),
  useCan: () => () => true,
}));

// The run on the case, as the investigation store would hand it over.
vi.mock('@/soc/investigations/useAiRun', () => ({
  useAiRun: (caseId: string | null | undefined) => (caseId && h.run?.case_id === caseId ? h.run : null),
  useAiRunFinished: (caseId: string | null | undefined) => (caseId && h.finished?.view.case_id === caseId ? h.finished : null),
  useAiRunCount: () => 0,
}));

import { CaseDetail, REINVESTIGATE_RUNNING_HINT } from '@/soc/pages/CaseDetail';
import {
  META_RING_RUN_PX,
  META_RUN_GAP,
  PREVIOUS_VERDICT_NOTE,
  runChipFit,
} from '@/soc/pages/casedetail/CaseHeaderMeta';

function running(state: InvestigationView['state'] = 'running'): InvestigationView {
  const now = Date.now();
  return {
    run_id: 'inv-1',
    case_id: CASE.case_id,
    state,
    phase: 'evidence',
    trigger: 'manual',
    queued_at: new Date(now - 40_000).toISOString(),
    started_at: state === 'queued' ? null : new Date(now - 38_000).toISOString(),
    deadline_at: new Date(now + 120_000).toISOString(),
    time_cap_seconds: 180,
    finished_at: null,
    outcome: null,
    status_after: null,
    verdict_after: null,
  } as InvestigationView;
}

async function renderLoaded() {
  render(<CaseDetail caseId={CASE.case_id} presentation="embedded" onClose={() => undefined} />);
  await waitFor(() => expect(document.querySelector('[data-case-title]')).toHaveTextContent(/Password spray/));
}

async function openTakeAction() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Take action/ }));
  return screen.findByRole('menu');
}

beforeEach(() => {
  window.localStorage.clear();
  h.run = null;
  h.finished = null;
});

/** Give the header's meta strip a measured width (jsdom lays nothing out). */
function stripWidth(width: number): () => void {
  const real = HTMLElement.prototype.getBoundingClientRect;
  const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute('data-testid') === 'case-detail-meta') {
      return { x: 0, y: 0, top: 0, left: 0, bottom: 24, right: width, width, height: 24, toJSON: () => ({}) } as DOMRect;
    }
    return real.call(this);
  });
  return () => spy.mockRestore();
}

describe('Take action while an AI investigation runs', () => {
  it('offers Reinvestigate when no run is under way', async () => {
    await renderLoaded();
    const menu = await openTakeAction();
    const item = within(menu).getByRole('menuitem', { name: /Reinvestigate/ });
    expect(item).not.toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAttribute('aria-keyshortcuts', 'R');
    expect(within(menu).queryByText(REINVESTIGATE_RUNNING_HINT)).toBeNull();
  });

  it.each(['running', 'queued'] as const)('makes Reinvestigate unavailable while a run is %s, and says why', async (state) => {
    h.run = running(state);
    await renderLoaded();
    const menu = await openTakeAction();
    const item = within(menu).getByRole('menuitem', { name: /Reinvestigate/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent('An AI investigation is already running.');
    expect(item).not.toHaveAttribute('aria-keyshortcuts');
    fireEvent.click(item);
    expect(screen.queryByRole('dialog', { name: /Reinvestigate/ })).toBeNull();
  });

  it('R opens no Reinvestigate dialog while a run is under way', async () => {
    h.run = running();
    await renderLoaded();
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    fireEvent.keyDown(document.body, { key: 'r' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByRole('dialog', { name: /Reinvestigate/ })).toBeNull();
  });
});

describe('the header verdict while an AI investigation runs', () => {
  it('dims the verdict the run replaces and names it Previous verdict', async () => {
    h.run = running();
    await renderLoaded();
    const verdict = document.querySelector('[data-meta-item="verdict"]') as HTMLElement;
    expect(verdict).toHaveAttribute('data-previous-verdict');
    const chip = within(verdict).getByTestId('case-ai-verdict');
    expect(chip).toHaveClass('border-dashed', 'text-muted-foreground');
    // The label word is dropped (the chip makes room for the run chip beside it).
    expect(within(chip).getByText('AI verdict', { selector: '[aria-hidden="true"]' })).toHaveClass('hidden');
    expect(within(verdict).getByText('Previous verdict:')).toHaveClass('sr-only');
    // The hover line leads with the note.
    const trigger = verdict.querySelector('[data-explain-trigger]') as HTMLElement;
    act(() => trigger.focus());
    await act(async () => {
      fireEvent.pointerEnter(trigger);
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const hover = await screen.findByTestId('explain-hover');
    expect(hover.textContent?.startsWith(PREVIOUS_VERDICT_NOTE)).toBe(true);
  });

  it('leaves the verdict as it was without a run', async () => {
    await renderLoaded();
    const verdict = document.querySelector('[data-meta-item="verdict"]') as HTMLElement;
    expect(verdict).not.toHaveAttribute('data-previous-verdict');
    expect(within(verdict).getByTestId('case-ai-verdict')).not.toHaveClass('border-dashed');
    expect(within(verdict).queryByText('Previous verdict:')).toBeNull();
  });

  it('fits the running chip to a measured phone-width strip: its mark and "AI", never a bare ring (FXB)', async () => {
    h.run = running();
    const restore = stripWidth(326);
    try {
      await renderLoaded();
      const chip = await screen.findByTestId('ai-run-chip');
      // A still ring under reduced motion says nothing on its own: the word stays.
      await waitFor(() => expect(chip).toHaveTextContent(/^AI$/));
      expect(chip).toHaveAttribute('data-run-state', 'running');
      // The closer spacing follows the chip itself (running or just finished), never a
      // run the chip does not show.
      expect(screen.getByTestId('case-detail-meta')).toHaveClass(...META_RUN_GAP.split(' '));
    } finally {
      restore();
    }
  });

  it('says "AI working" with the clock on the 779px strip of Case Manager at 1440 by 900 (XFCM)', async () => {
    h.run = running();
    const restore = stripWidth(779);
    try {
      await renderLoaded();
      const chip = await screen.findByTestId('ai-run-chip');
      await waitFor(() => expect(chip).toHaveTextContent(/^AI working · 0:3\d$/));
      // The status words stay whole beside it (the owner's name and the SLA make room).
      expect(screen.getByTestId('case-detail-status')).toHaveTextContent(/^Investigating$/);
    } finally {
      restore();
    }
  });

  it('says "AI queued" on a 30rem strip, and its mark with "AI" just below it (XFCM, FXB)', async () => {
    h.run = running('queued');
    const restore = stripWidth(META_RING_RUN_PX);
    try {
      await renderLoaded();
      const chip = await screen.findByTestId('ai-run-chip');
      await waitFor(() => expect(chip).toHaveTextContent(/^AI queued$/));
    } finally {
      restore();
    }
    cleanup();
    const narrow = stripWidth(META_RING_RUN_PX - 1);
    try {
      await renderLoaded();
      const chip = await screen.findByTestId('ai-run-chip');
      await waitFor(() => expect(chip).toHaveTextContent(/^AI$/));
      expect(chip).toHaveAttribute('aria-label', 'AI queued. Show the AI investigation');
    } finally {
      narrow();
    }
  });

  it('says "AI finished" after the run on every strip of 30rem or wider, its mark with "AI" on a phone (XFCM, FXB)', async () => {
    // The run just ended on this console: the chip shows its success tint for a few seconds.
    h.finished = { view: { ...running(), state: 'finished', outcome: 'decided' } as InvestigationView, at: Date.now(), active: true, shown: true };
    const phone = stripWidth(326);
    try {
      await renderLoaded();
      const chip = await screen.findByTestId('ai-run-chip');
      expect(chip).toHaveAttribute('data-run-state', 'finished');
      await waitFor(() => expect(chip).toHaveTextContent(/^AI$/));
      expect(chip).toHaveAttribute('aria-label', 'AI finished. Show the AI investigation');
    } finally {
      phone();
    }
    for (const width of [779, 919, 1100]) {
      cleanup();
      const restore = stripWidth(width);
      try {
        await renderLoaded();
        const chip = await screen.findByTestId('ai-run-chip');
        await waitFor(() => expect(chip).toHaveTextContent(/^AI finished$/));
      } finally {
        restore();
      }
    }
  });

  it('fits the run chip to the strip: its words from 30rem, its mark and "AI" below (XFCM, FXB)', () => {
    expect(runChipFit(null)).toBe(false);
    expect(runChipFit(0)).toBe(false);
    expect(runChipFit(1100)).toBe(false);
    // 1440 by 900 in Case Manager, navigation open and collapsed: 779px and 919px strips.
    expect(runChipFit(779)).toBe(false);
    expect(runChipFit(919)).toBe(false);
    expect(runChipFit(META_RING_RUN_PX)).toBe(false);
    expect(runChipFit(META_RING_RUN_PX - 1)).toBe('ring');
    // 390 by 844: a 326px strip.
    expect(runChipFit(326)).toBe('ring');
  });
});

describe('the Signal section event count', () => {
  it('opens the Evidence tab, where the events table is', async () => {
    await renderLoaded();
    const line = await screen.findByTestId('signal-event-count');
    expect(line).toHaveTextContent('The case holds 3 events.');
    fireEvent.click(within(line).getByRole('button', { name: '3 events. Show them on the Evidence tab' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: /Evidence/ })).toHaveAttribute('aria-selected', 'true'));
  });
});
