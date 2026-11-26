/**
 * The case header chip and its popover (Round 16 SPEC §4.5 WP09, S1 and S2): "AI working ·
 * m:ss" ticking each second, "AI queued", a 6 s success tint after a run this console
 * showed ends, the popover's steps, who or what started the run (one line per trigger,
 * and the requester's name only when the route gave it), the time against the cap, the
 * queued line, and one polite announcement per change at most every 10 s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import type { InvestigationsActive, InvestigationView } from '@/lib/types';

const h = vi.hoisted(() => ({
  read: vi.fn(),
  onEvent: null as null | ((ev: { type: string; data: unknown; lastEventId: string }) => void),
  onLive: null as null | ((live: boolean) => void),
  announce: vi.fn(),
}));

vi.mock('@/lib/api-investigations', () => ({ getActiveInvestigations: h.read }));
vi.mock('@/lib/useEventStream', () => ({
  subscribeEvents: (_topics: string[], opts: { onEvent: typeof h.onEvent; onLive: typeof h.onLive }) => {
    h.onEvent = opts.onEvent;
    h.onLive = opts.onLive;
    return () => undefined;
  },
}));
vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => h.announce }));
vi.mock('@/soc/auth', () => ({ useAuth: () => ({ hasPermission: () => true }) }));

import { AiRunChip, FINISHED_TINT_MS } from '../AiRunChip';
import { ACT_NOW_TEXT, aiRunFinishedText, aiRunOrigin, aiRunTimeLine, capWords } from '../AiRunPopover';
import { HOLD_OFF_MS, resetInvestigationsForTests } from '../store';

const T0 = Date.parse('2026-11-25T10:00:00Z');

function view(over: Partial<InvestigationView> = {}): InvestigationView {
  return {
    run_id: 'inv-1',
    case_id: 'case-1',
    state: 'running',
    phase: 'evidence',
    trigger: 'manual',
    queued_at: new Date(T0 - 2_000).toISOString(),
    started_at: new Date(T0 - 2_000).toISOString(),
    deadline_at: new Date(T0 + 118_000).toISOString(),
    time_cap_seconds: 120,
    finished_at: null,
    outcome: null,
    status_after: null,
    verdict_after: null,
    ...over,
  };
}

function body(over: Partial<InvestigationsActive> = {}): InvestigationsActive {
  return {
    items: [],
    recent: [],
    new_runs: 0,
    slots: { in_use: 3, cap: 3 },
    process_local: true,
    generated_at: new Date(Date.now()).toISOString(),
    ...over,
  };
}

/** Answer every read with a fresh body (its `generated_at` is the time of the read). */
function serve(over: Partial<InvestigationsActive> = {}) {
  h.read.mockImplementation(async () => body(over));
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Open the popover and let its read of the run land. */
async function openPopover() {
  fireEvent.click(screen.getByTestId('ai-run-chip'));
  await settle();
  return screen.getByTestId('ai-run-popover');
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(T0);
  resetInvestigationsForTests();
  h.read.mockReset();
  serve();
  h.onEvent = null;
  h.onLive = null;
  h.announce.mockReset();
});

afterEach(() => {
  resetInvestigationsForTests();
  vi.useRealTimers();
});

describe('the header chip', () => {
  it('renders nothing without a run', async () => {
    const { container } = render(<AiRunChip caseId="case-1" />);
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows "AI working · m:ss" and ticks each second', async () => {
    serve({ items: [view({ requested_by_you: true })] });
    render(<AiRunChip caseId="case-1" />);
    await settle();
    const chip = screen.getByTestId('ai-run-chip');
    expect(chip).toHaveTextContent('AI working · 0:02');
    expect(chip).toHaveAttribute('aria-label', 'AI working. Show the AI investigation');
    expect(chip.querySelector('[data-activity="running"]')).not.toBeNull();
    await settle(40_000);
    expect(chip).toHaveTextContent('AI working · 0:42');
  });

  it('drops its words when compact, and keeps the ring alone for a phone-width line (WP16)', async () => {
    serve({ items: [view()] });
    const { rerender } = render(<AiRunChip caseId="case-1" compact />);
    await settle();
    const chip = screen.getByTestId('ai-run-chip');
    expect(chip).toHaveTextContent(/^0:02$/);
    rerender(<AiRunChip caseId="case-1" compact="ring" />);
    expect(chip).toHaveTextContent('');
    expect(chip.querySelector('[data-activity="running"]')).not.toBeNull();
    // The name still says what it is.
    expect(chip).toHaveAttribute('aria-label', 'AI working. Show the AI investigation');
  });

  it('says "AI queued" and the waiting line with the slots in use', async () => {
    serve({ items: [view({ state: 'queued', phase: 'queued', started_at: null, deadline_at: null })] });
    render(<AiRunChip caseId="case-1" />);
    await settle();
    expect(screen.getByTestId('ai-run-chip')).toHaveTextContent(/^AI queued$/);
    const pop = await openPopover();
    expect(within(pop).getByText('AI investigation waiting')).toBeInTheDocument();
    expect(pop).toHaveTextContent(
      'Waiting for a free slot: 3 of 3 investigations are running. The time cap starts when it begins.',
    );
    // No step is current while the run waits.
    expect(pop.querySelector('[aria-current="step"]')).toBeNull();
  });

  it('opens a named popover with the steps, the current one marked, the time and what acting now does', async () => {
    serve({ items: [view({ requested_by_you: true })] });
    render(<AiRunChip caseId="case-1" />);
    await settle(40_000);
    const pop = await openPopover();
    const content = pop.closest('[role="dialog"]') ?? pop.parentElement!;
    const labelled = content.getAttribute('aria-labelledby');
    expect(labelled && document.getElementById(labelled)).toHaveTextContent('AI investigation running');
    const steps = within(pop).getAllByRole('listitem').map((li) => li.textContent);
    expect(steps).toEqual([
      '1. Triage (done)',
      '2. Specialist and runbook (done)',
      '3. Looking up evidence',
      '4. Verdict',
      '5. Deciding',
    ]);
    expect(within(pop).getAllByRole('listitem')[2]).toHaveAttribute('aria-current', 'step');
    expect(pop).toHaveTextContent('You started it.');
    expect(pop).toHaveTextContent('Started 42 seconds ago. The time cap for an investigation is 2 minutes.');
    expect(pop).toHaveTextContent(ACT_NOW_TEXT);
    const link = within(pop).getByRole('link', { name: 'See its steps in the audit log' });
    expect(link.getAttribute('href')).toContain('audit');
    expect(link.getAttribute('href')).toContain('case-1');
  });

  it('tints for 6 s after a run it showed ends, and announces the end', async () => {
    serve({ items: [view({ requested_by_you: true })] });
    render(<AiRunChip caseId="case-1" />);
    await settle();
    expect(h.announce).toHaveBeenLastCalledWith('AI investigation running: looking up evidence.', 'polite');
    act(() =>
      h.onEvent?.({
        type: 'case.investigation',
        data: {
          ...view({ state: 'finished', phase: 'decision', outcome: 'decided', status_after: 'needs_human', verdict_after: 'NEEDS_HUMAN' }),
          active: 0,
          new_runs: 0,
        },
        lastEventId: '9',
      }),
    );
    const chip = screen.getByTestId('ai-run-chip');
    expect(chip).toHaveAttribute('data-run-state', 'finished');
    expect(chip).toHaveTextContent('AI finished');
    // At most one announcement every 10 s: the end is said at the 10 s mark.
    await settle(10_000);
    expect(h.announce).toHaveBeenLastCalledWith('AI investigation finished: Open · awaiting analyst.', 'polite');
    expect(screen.queryByTestId('ai-run-chip')).toBeNull();
  });

  it('drops the tint after 6 s', async () => {
    serve({ items: [view()] });
    render(<AiRunChip caseId="case-1" />);
    await settle();
    act(() =>
      h.onEvent?.({
        type: 'case.investigation',
        data: { ...view({ state: 'finished', outcome: 'unchanged' }), active: 0, new_runs: 0 },
        lastEventId: '10',
      }),
    );
    expect(screen.getByTestId('ai-run-chip')).toBeInTheDocument();
    await settle(FINISHED_TINT_MS - 100);
    expect(screen.getByTestId('ai-run-chip')).toBeInTheDocument();
    await settle(200);
    expect(screen.queryByTestId('ai-run-chip')).toBeNull();
  });

  it('shows no tint for a run it never showed (it ended within the hold-off)', async () => {
    render(<AiRunChip caseId="case-1" />);
    await settle();
    const fresh = view({ trigger: 'automatic', queued_at: new Date(T0).toISOString(), started_at: new Date(T0).toISOString() });
    act(() => h.onEvent?.({ type: 'case.investigation', data: { ...fresh, active: 1, new_runs: 0 }, lastEventId: '11' }));
    await settle(HOLD_OFF_MS / 2);
    act(() =>
      h.onEvent?.({
        type: 'case.investigation',
        data: { ...fresh, state: 'finished', outcome: 'decided', status_after: 'closed', active: 0, new_runs: 0 },
        lastEventId: '12',
      }),
    );
    await settle(HOLD_OFF_MS);
    expect(screen.queryByTestId('ai-run-chip')).toBeNull();
  });

  it('reads the case once when it opens and the page has no live stream', async () => {
    // Another reader (the navigation, say) already holds the store and made its read.
    render(<AiRunChip caseId="case-0" />);
    await settle();
    h.read.mockClear();
    render(<AiRunChip caseId="case-1" />);
    await settle();
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.read).toHaveBeenCalledWith('case-1');
    // With a live stream, a case opening reads nothing more.
    act(() => h.onLive?.(true));
    await settle();
    h.read.mockClear();
    render(<AiRunChip caseId="case-2" />);
    await settle();
    expect(h.read).not.toHaveBeenCalled();
  });
});

describe('the popover lines', () => {
  it('say who or what started the run, for every trigger', () => {
    expect(aiRunOrigin(view({ trigger: 'manual', requested_by_you: true }))).toBe('You started it.');
    expect(aiRunOrigin(view({ trigger: 'manual', requested_by: 'alice' }))).toBe('Started by alice.');
    expect(aiRunOrigin(view({ trigger: 'manual' }))).toBe('Started by a person.');
    expect(aiRunOrigin(view({ trigger: 'automatic' }))).toBe('Started automatically.');
    expect(aiRunOrigin(view({ trigger: 'job' }))).toBe('Started by a background job.');
    expect(aiRunOrigin(view({ trigger: 'drain' }))).toBe('Started when an investigation slot came free.');
    expect(aiRunOrigin(view({ trigger: 'detection' }))).toBe('Started by event detection.');
  });

  it('show a requester name as text (#9)', async () => {
    serve({ items: [view({ requested_by: '<b>mallory</b>' })] });
    render(<AiRunChip caseId="case-1" />);
    await settle();
    const pop = await openPopover();
    expect(pop).toHaveTextContent('Started by <b>mallory</b>.');
    expect(pop.querySelector('b')).toBeNull();
  });

  it('state the cap, not a promised end time, and the outcome words', () => {
    expect(capWords(120)).toBe('2 minutes');
    expect(capWords(90)).toBe('90 seconds');
    expect(aiRunTimeLine(view({ time_cap_seconds: 0 }), null, T0 + 3_000)).toBe('Started 5 seconds ago.');
    expect(aiRunTimeLine(view({ state: 'queued' }), null, T0)).toBe(
      'Waiting for a free investigation slot. The time cap starts when it begins.',
    );
    expect(aiRunFinishedText(view({ outcome: 'cancelled' }))).toBe(
      'AI investigation stopped before it finished. The case was not changed.',
    );
    expect(aiRunFinishedText(view({ outcome: 'failed' }))).toBe('AI investigation could not finish.');
    expect(aiRunFinishedText(view({ outcome: 'unchanged' }))).toBe('AI investigation finished: no change to the case.');
    expect(aiRunFinishedText(view({ outcome: 'decided', status_after: 'closed' }))).toBe('AI investigation finished: Closed.');
  });
});

describe('the hold-off', () => {
  it('shows a run the server began a while ago at once, and a new one after 1 s', async () => {
    render(<AiRunChip caseId="case-1" />);
    await settle();
    const fresh = view({ trigger: 'automatic', queued_at: new Date(T0).toISOString(), started_at: new Date(T0).toISOString() });
    act(() => h.onEvent?.({ type: 'case.investigation', data: { ...fresh, active: 1, new_runs: 0 }, lastEventId: '13' }));
    expect(screen.queryByTestId('ai-run-chip')).toBeNull();
    await settle(HOLD_OFF_MS);
    expect(screen.getByTestId('ai-run-chip')).toHaveTextContent('AI working · 0:01');
  });
});
