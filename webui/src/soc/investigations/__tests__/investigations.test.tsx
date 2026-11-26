/**
 * The AI run words and marks (Round 16 SPEC §4.5 WP09): the queue row's accessible name,
 * the row mark in the status node, and the band line for runs on new events. They read
 * the real investigation store, fed here through its two inputs: the reconcile read and
 * the `case.investigation` frames.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import type { InvestigationsActive, InvestigationView } from '@/lib/types';

const h = vi.hoisted(() => ({
  read: vi.fn(),
  onEvent: null as null | ((ev: { type: string; data: unknown; lastEventId: string }) => void),
  announce: vi.fn(),
}));

vi.mock('@/lib/api-investigations', () => ({ getActiveInvestigations: h.read }));
vi.mock('@/lib/useEventStream', () => ({
  subscribeEvents: (_topics: string[], opts: { onEvent: typeof h.onEvent }) => {
    h.onEvent = opts.onEvent;
    return () => undefined;
  },
}));
vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => h.announce }));

import { aiRunAccessibleText, elapsedClock, spokenDuration } from '../aiRunText';
import { AiRunMark } from '../AiRunMark';
import { AiQueueNotice, newRunsText } from '../AiQueueNotice';
import { HOLD_OFF_MS, resetInvestigationsForTests } from '../store';

const T0 = Date.parse('2026-11-25T10:00:00Z');

function view(over: Partial<InvestigationView> = {}): InvestigationView {
  return {
    run_id: 'inv-1',
    case_id: 'case-1',
    state: 'running',
    phase: 'triage',
    trigger: 'automatic',
    queued_at: new Date(Date.now()).toISOString(),
    started_at: new Date(Date.now()).toISOString(),
    deadline_at: new Date(Date.now() + 120_000).toISOString(),
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
    slots: { in_use: 0, cap: 3 },
    process_local: true,
    generated_at: new Date(Date.now()).toISOString(),
    ...over,
  };
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetInvestigationsForTests();
  h.read.mockReset();
  h.read.mockResolvedValue(body());
  h.onEvent = null;
  h.announce.mockReset();
});

afterEach(() => {
  resetInvestigationsForTests();
  vi.useRealTimers();
});

describe('the run words', () => {
  it('give the queue row a bare phrase that joins its accessible name', () => {
    const now = T0 + 40_000;
    const running = view({ started_at: new Date(T0).toISOString() });
    expect(aiRunAccessibleText(running, now)).toBe('AI investigation running, started 40 seconds ago');
    // The row joins its parts with ", ", so the name ends with the run's words.
    const name = ['Brute force on host-7', 'CASE-0042', 'Open', aiRunAccessibleText(running, now)].join(', ');
    expect(name.endsWith(', AI investigation running, started 40 seconds ago')).toBe(true);
    expect(aiRunAccessibleText(view({ state: 'queued', started_at: null, queued_at: new Date(T0).toISOString() }), T0 + 61_000)).toBe(
      'AI investigation waiting, queued 1 minute ago',
    );
    expect(aiRunAccessibleText(view({ state: 'finished' }), now)).toBeNull();
    expect(aiRunAccessibleText(null, now)).toBeNull();
  });

  it('never says "Investigating" alone and counts time plainly', () => {
    expect(spokenDuration(1_000)).toBe('1 second');
    expect(spokenDuration(120_000)).toBe('2 minutes');
    expect(spokenDuration(7_200_000)).toBe('2 hours');
    expect(elapsedClock(new Date(T0).toISOString(), T0 + 42_000)).toBe('0:42');
    expect(elapsedClock(new Date(T0).toISOString(), T0 + 3_729_000)).toBe('1:02:09');
    expect(elapsedClock(null, T0)).toBe('0:00');
    const words = [
      aiRunAccessibleText(view(), T0 + 5_000),
      aiRunAccessibleText(view({ state: 'queued' }), T0 + 5_000),
    ].join(' ');
    expect(words).not.toMatch(/\bInvestigating\b/);
  });
});

describe('the queue row mark', () => {
  it('shows the turning ring and "AI working" after the 1 s hold-off, and nothing before', async () => {
    render(<AiRunMark caseId="case-1" />);
    await settle();
    act(() => h.onEvent?.({ type: 'case.investigation', data: { ...view(), active: 1, new_runs: 0 }, lastEventId: '1' }));
    expect(screen.queryByTestId('ai-run-mark')).toBeNull();
    await settle(HOLD_OFF_MS);
    const mark = screen.getByTestId('ai-run-mark');
    expect(mark).toHaveTextContent('AI working');
    expect(mark).toHaveAttribute('aria-hidden');
    // The ring is the chat activity glyph; it stands still under reduced motion (below).
    expect(mark.querySelector('[data-activity="running"]')).not.toBeNull();
  });

  it('takes classes for its words, so a narrow row keeps the ring alone (WP16)', async () => {
    h.read.mockResolvedValue(body({ items: [view({ queued_at: new Date(T0 - 5_000).toISOString() })] }));
    render(<AiRunMark caseId="case-1" wordsClassName="hidden @[30rem]/queue:inline" />);
    await settle();
    const words = screen.getByTestId('ai-run-mark-words');
    expect(words).toHaveTextContent('AI working');
    expect(words).toHaveClass('hidden', '@[30rem]/queue:inline');
  });

  it('says "AI queued" for a run waiting for a slot, and goes when the run ends', async () => {
    h.read.mockResolvedValue(body({ items: [view({ state: 'queued', phase: 'queued', started_at: null, queued_at: new Date(T0 - 5_000).toISOString() })] }));
    render(<AiRunMark caseId="case-1" />);
    await settle();
    expect(screen.getByTestId('ai-run-mark')).toHaveTextContent('AI queued');
    act(() =>
      h.onEvent?.({
        type: 'case.investigation',
        data: { ...view({ state: 'finished', outcome: 'decided', status_after: 'needs_human' }), active: 0, new_runs: 0 },
        lastEventId: '2',
      }),
    );
    expect(screen.queryByTestId('ai-run-mark')).toBeNull();
  });

  it('keeps the turning ring still under reduced motion (the animation is motion-gated)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(resolve(here, '../../../styles/activity.css'), 'utf8');
    // Every animation sits inside the one no-preference block; outside it the ring is still.
    const gate = css.indexOf('@media (prefers-reduced-motion: no-preference)');
    expect(gate).toBeGreaterThan(-1);
    expect(css.slice(0, gate)).not.toMatch(/animation\s*:/);
    expect(css.slice(gate)).toMatch(/\.chat-activity\[data-activity='running'\]\s*\{\s*animation:/);
  });
});

describe('the band line for runs on new events', () => {
  it('is hidden at 0 and says the count after the hold-off, announced politely', async () => {
    render(<AiQueueNotice />);
    await settle();
    expect(screen.queryByTestId('ai-queue-notice')).toBeNull();
    act(() => h.onEvent?.({ type: 'case.investigation', data: { ...view({ case_id: null }), active: 2, new_runs: 2 }, lastEventId: '3' }));
    expect(screen.queryByTestId('ai-queue-notice')).toBeNull();
    await settle(HOLD_OFF_MS);
    const line = screen.getByTestId('ai-queue-notice');
    expect(line).toHaveTextContent('AI is investigating 2 new alerts. They join the queue when the investigation finishes.');
    // One quiet 16 px line that truncates.
    expect(line.className).toContain('text-xs');
    expect(line.className).toContain('leading-4');
    expect(line.className).toContain('truncate');
    expect(h.announce).toHaveBeenCalledWith(
      'AI is investigating 2 new alerts. They join the queue when the investigation finishes.',
      'polite',
    );
  });

  it('words one alert in the singular and nothing at 0', () => {
    expect(newRunsText(0)).toBe('');
    expect(newRunsText(1)).toBe('AI is investigating 1 new alert. It joins the queue when the investigation finishes.');
    expect(newRunsText(1200)).toBe(
      'AI is investigating 1,200 new alerts. They join the queue when the investigation finishes.',
    );
  });

  it('announces at most once every 10 s, and the last word is never lost', async () => {
    render(<AiQueueNotice />);
    await settle();
    const send = (n: number, id: string) =>
      act(() => h.onEvent?.({ type: 'case.investigation', data: { ...view({ run_id: `r${id}`, case_id: null }), active: n, new_runs: n }, lastEventId: id }));
    send(1, '10');
    await settle(HOLD_OFF_MS);
    expect(h.announce).toHaveBeenCalledTimes(1);
    send(2, '11');
    await settle(100);
    send(3, '12');
    await settle(100);
    expect(h.announce).toHaveBeenCalledTimes(1);
    await settle(10_000);
    expect(h.announce).toHaveBeenCalledTimes(2);
    expect(h.announce).toHaveBeenLastCalledWith(
      'AI is investigating 3 new alerts. They join the queue when the investigation finishes.',
      'polite',
    );
  });
});

describe('the store and its readers', () => {
  it('renders every value as text (#9)', async () => {
    h.read.mockResolvedValue(body({ items: [view({ run_id: '<img src=x onerror=alert(1)>' })] }));
    const { container } = render(<AiRunMark caseId="case-1" />);
    await settle();
    expect(container.querySelector('img')).toBeNull();
  });

  it('drops a frame that is not a run', async () => {
    render(<AiRunMark caseId="case-1" />);
    await settle();
    act(() => h.onEvent?.({ type: 'case.investigation', data: { run_id: 'x', state: 'thinking', case_id: 'case-1' }, lastEventId: '20' }));
    await settle(HOLD_OFF_MS);
    expect(screen.queryByTestId('ai-run-mark')).toBeNull();
  });
});
