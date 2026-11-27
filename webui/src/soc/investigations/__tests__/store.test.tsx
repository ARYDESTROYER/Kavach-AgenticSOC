/**
 * The investigation store (Round 16 SPEC §4.5 WP09): frames, the 1 s hold-off, a finish,
 * the client expiry at `deadline_at + 60 s` and the reconcile read on mount, reconnect
 * and `overflow`, plus the 5 s polling fallback while a run is known and the stream is
 * not live.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import type { InvestigationsActive, InvestigationView } from '@/lib/types';

const h = vi.hoisted(() => ({
  read: vi.fn(),
  onEvent: null as null | ((ev: { type: string; data: unknown; lastEventId: string }) => void),
  onLive: null as null | ((live: boolean) => void),
  topics: [] as string[][],
  unsubscribed: 0,
}));

vi.mock('@/lib/api-investigations', () => ({ getActiveInvestigations: h.read }));
vi.mock('@/lib/useEventStream', () => ({
  subscribeEvents: (topics: string[], opts: { onEvent: typeof h.onEvent; onLive: typeof h.onLive }) => {
    h.topics.push(topics);
    h.onEvent = opts.onEvent;
    h.onLive = opts.onLive;
    return () => {
      h.unsubscribed += 1;
    };
  },
}));

import {
  EXPIRY_GRACE_MS,
  HOLD_OFF_MS,
  POLL_MS,
  investigationSnapshot,
  noteReinvestigationStarted,
  parseRun,
  resetInvestigationsForTests,
  useInvestigations,
} from '../store';
import { useAiRun, useAiRunCount, useAiRunFinished } from '../useAiRun';
import { useAiCaseCount } from '../count';

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

function frame(data: Record<string, unknown>) {
  act(() => h.onEvent?.({ type: 'case.investigation', data: { active: 1, new_runs: 0, ...data }, lastEventId: '1' }));
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetInvestigationsForTests();
  h.read.mockReset();
  h.read.mockResolvedValue(body());
  h.onEvent = null;
  h.onLive = null;
  h.topics = [];
  h.unsubscribed = 0;
});

afterEach(() => {
  resetInvestigationsForTests();
  vi.useRealTimers();
});

describe('the store reducer', () => {
  it('subscribes the investigations topic and reads the route when its first reader mounts', async () => {
    renderHook(() => useAiRun('case-1'));
    renderHook(() => useAiRun('case-2'));
    await flush();
    expect(h.topics).toEqual([['investigations']]);
    expect(h.read).toHaveBeenCalledTimes(1);
  });

  it('shows a run from a frame after the 1 s hold-off, then forgets it when it finishes', async () => {
    const run = renderHook(() => useAiRun('case-1'));
    const done = renderHook(() => useAiRunFinished('case-1'));
    await flush();
    frame(view());
    expect(run.result.current).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_OFF_MS);
    });
    expect(run.result.current?.run_id).toBe('inv-1');
    frame(view({ state: 'finished', outcome: 'decided', status_after: 'needs_human', verdict_after: 'NEEDS_HUMAN' }));
    expect(run.result.current).toBeNull();
    expect(done.result.current?.view.status_after).toBe('needs_human');
    expect(done.result.current?.shown).toBe(true);
    expect(done.result.current?.active).toBe(true);
  });

  it('never shows a run that ends within the hold-off', async () => {
    const run = renderHook(() => useAiRun('case-1'));
    const done = renderHook(() => useAiRunFinished('case-1'));
    await flush();
    frame(view());
    frame(view({ state: 'finished', outcome: 'unchanged' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_OFF_MS * 2);
    });
    expect(run.result.current).toBeNull();
    expect(done.result.current?.shown).toBe(false);
  });

  it('shows at once a run the route says began a while ago', async () => {
    h.read.mockResolvedValue(
      body({ items: [view({ queued_at: new Date(T0 - 30_000).toISOString(), started_at: new Date(T0 - 29_000).toISOString() })] }),
    );
    const run = renderHook(() => useAiRun('case-1'));
    await flush();
    expect(run.result.current?.run_id).toBe('inv-1');
  });

  it('moves server times into the browser clock', async () => {
    // The server clock is 5 minutes ahead of this browser.
    const ahead = 5 * 60_000;
    h.read.mockResolvedValue(
      body({
        generated_at: new Date(T0 + ahead).toISOString(),
        items: [view({ queued_at: new Date(T0 + ahead - 40_000).toISOString(), started_at: new Date(T0 + ahead - 40_000).toISOString() })],
      }),
    );
    const run = renderHook(() => useAiRun('case-1'));
    await flush();
    expect(Date.parse(run.result.current!.started_at!)).toBe(T0 - 40_000);
  });

  it('expires a run at deadline + 60 s and reads the route again', async () => {
    const run = renderHook(() => useAiRun('case-1'));
    await flush();
    const late = view({ deadline_at: new Date(T0 + 10_000).toISOString() });
    // The route lists the run while the stream opens; by the expiry it no longer does.
    h.read.mockImplementation(async () => body({ items: [late] }));
    frame(late);
    act(() => h.onLive?.(true));
    await flush();
    h.read.mockClear();
    h.read.mockImplementation(async () => body());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000 + EXPIRY_GRACE_MS - 1);
    });
    expect(run.result.current).not.toBeNull();
    expect(h.read).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(run.result.current).toBeNull();
    expect(h.read).toHaveBeenCalledTimes(1);
  });

  it('keeps a run the route still lists past its expiry and checks it once a minute, never in a loop', async () => {
    // The server clock is ahead and the run is long past its deadline (its hooks run on).
    const ahead = 5 * 60_000;
    const stuck = () =>
      body({
        generated_at: new Date(Date.now() + ahead).toISOString(),
        items: [
          view({
            queued_at: new Date(T0 + ahead - 400_000).toISOString(),
            started_at: new Date(T0 + ahead - 400_000).toISOString(),
            deadline_at: new Date(T0 + ahead - 280_000).toISOString(),
          }),
        ],
      });
    h.read.mockImplementation(async () => stuck());
    const run = renderHook(() => useAiRun('case-1'));
    act(() => h.onLive?.(true));
    await flush();
    expect(run.result.current?.run_id).toBe('inv-1');
    h.read.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXPIRY_GRACE_MS - 1);
    });
    expect(h.read).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXPIRY_GRACE_MS * 2);
    });
    // One read per minute, and the server's word keeps the run on screen.
    expect(h.read.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(h.read.mock.calls.length).toBeLessThanOrEqual(3);
    expect(run.result.current?.run_id).toBe('inv-1');
  });

  it('does not spin the poll timer while a slow read is in flight', async () => {
    renderHook(() => useAiRun('case-1'));
    await flush();
    frame(view({ queued_at: new Date(T0 - 5_000).toISOString() }));
    let answer: (value: InvestigationsActive) => void = () => undefined;
    h.read.mockClear();
    h.read.mockImplementation(() => new Promise<InvestigationsActive>((resolve) => (answer = resolve)));
    const timers = vi.spyOn(globalThis, 'setTimeout');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 6);
    });
    // One poll went out and waits; no timer fires again and again behind it (a spinning
    // poll would set a new timer every millisecond, while the coalesced read call hides it).
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
    expect(timers.mock.calls.length).toBeLessThan(10);
    timers.mockRestore();
    await act(async () => {
      answer(body({ items: [view({ queued_at: new Date(T0 - 5_000).toISOString() })] }));
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it('reconciles: drops runs the server no longer has, records recent ones, counts new runs', async () => {
    const run = renderHook(() => useAiRun('case-1'));
    const newRuns = renderHook(() => useInvestigations((s) => s.newRuns));
    await flush();
    frame(view());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_OFF_MS);
    });
    expect(run.result.current).not.toBeNull();
    h.read.mockResolvedValue(body({ recent: [view({ state: 'finished', outcome: 'decided' })], new_runs: 2 }));
    act(() => h.onEvent?.({ type: 'overflow', data: { dropped: 4 }, lastEventId: '' }));
    await flush();
    expect(run.result.current).toBeNull();
    expect(investigationSnapshot().finished.get('case-1')?.view.outcome).toBe('decided');
    // The count of new runs is held off too.
    expect(newRuns.result.current).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_OFF_MS);
    });
    expect(newRuns.result.current).toBe(2);
  });

  it('reads the route again when the stream (re)opens', async () => {
    renderHook(() => useAiRun('case-1'));
    await flush();
    expect(h.read).toHaveBeenCalledTimes(1);
    act(() => h.onLive?.(true));
    await flush();
    expect(h.read).toHaveBeenCalledTimes(2);
    act(() => h.onLive?.(false));
    act(() => h.onLive?.(true));
    await flush();
    expect(h.read).toHaveBeenCalledTimes(3);
  });

  it('polls every 5 s while a run is known and the stream is not live, and stops when it is live', async () => {
    renderHook(() => useAiRun('case-1'));
    await flush();
    frame(view());
    h.read.mockClear();
    h.read.mockResolvedValue(body({ items: [view()] }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(h.read).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(h.read).toHaveBeenCalledTimes(2);
    act(() => h.onLive?.(true));
    await flush();
    h.read.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    expect(h.read).not.toHaveBeenCalled();
  });

  it('keeps the requester of a run seen first on a frame, by asking the route', async () => {
    renderHook(() => useAiRun('case-1'));
    await flush();
    h.read.mockResolvedValue(body({ items: [view({ trigger: 'manual', requested_by_you: true })] }));
    frame(view({ trigger: 'manual' }));
    await flush();
    frame(view({ trigger: 'manual', phase: 'evidence' }));
    const run = investigationSnapshot();
    void run;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_OFF_MS);
    });
    const shown = investigationSnapshot().byCase.get('case-1');
    expect(shown?.requested_by_you).toBe(true);
    expect(shown?.phase).toBe('evidence');
  });

  it('shows a run this console started at once, until the server takes over', async () => {
    const run = renderHook(() => useAiRun('case-1'));
    await flush();
    act(() => noteReinvestigationStarted('case-1', 'inv-9'));
    expect(run.result.current).toMatchObject({ run_id: 'inv-9', state: 'queued', requested_by_you: true });
    // A read that does not list it yet (the run waits for its signature lock) keeps it.
    h.read.mockResolvedValue(body());
    act(() => h.onEvent?.({ type: 'overflow', data: {}, lastEventId: '' }));
    await flush();
    expect(run.result.current?.run_id).toBe('inv-9');
    frame(view({ run_id: 'inv-9', trigger: 'manual' }));
    expect(run.result.current).toMatchObject({ run_id: 'inv-9', state: 'running', requested_by_you: true });
  });

  it('shows the end of a run that finished before its 202 arrived, as started here', async () => {
    const done = renderHook(() => useAiRunFinished('case-1'));
    await flush();
    // A quick run: its last frame lands before the reinvestigation's answer does.
    frame(view({ run_id: 'inv-9', trigger: 'manual', state: 'finished', outcome: 'decided', status_after: 'needs_human' }));
    expect(done.result.current).toMatchObject({ active: false, shown: false });
    act(() => noteReinvestigationStarted('case-1', 'inv-9'));
    expect(done.result.current).toMatchObject({ active: true, shown: true });
    expect(done.result.current?.view.requested_by_you).toBe(true);
    // No run is left behind as queued.
    expect(investigationSnapshot().byCase.size).toBe(0);
  });

  it('shows the end of a run seen only inside the hold-off when its 202 arrives', async () => {
    const done = renderHook(() => useAiRunFinished('case-1'));
    await flush();
    frame(view({ run_id: 'inv-8', trigger: 'manual' }));
    frame(view({ run_id: 'inv-8', trigger: 'manual', state: 'finished', outcome: 'decided', status_after: 'needs_human' }));
    expect(done.result.current).toMatchObject({ active: true, shown: false });
    act(() => noteReinvestigationStarted('case-1', 'inv-8'));
    expect(done.result.current).toMatchObject({ active: true, shown: true });
    expect(done.result.current?.view.requested_by_you).toBe(true);
  });

  it('never brings back a run that ended while a read was on its way', async () => {
    const run = renderHook(() => useAiRun('case-1'));
    const done = renderHook(() => useAiRunFinished('case-1'));
    await flush();
    let answer: (value: InvestigationsActive) => void = () => undefined;
    h.read.mockImplementation(() => new Promise<InvestigationsActive>((resolve) => (answer = resolve)));
    // A manual run's first frame sends a read (it asks who started it); the run ends first.
    const running = view({ run_id: 'inv-7', trigger: 'manual', queued_at: new Date(T0 - 5000).toISOString() });
    frame(running);
    expect(h.read).toHaveBeenCalledTimes(2);
    frame({ ...running, state: 'finished', phase: 'decision', outcome: 'decided', status_after: 'needs_human', finished_at: new Date(T0).toISOString() });
    expect(run.result.current).toBeNull();
    // The read was answered before the end: it still lists the run as running, and an older
    // run as the case's last finished one.
    const older = view({ run_id: 'inv-1', state: 'finished', outcome: 'unchanged', finished_at: new Date(T0 - 60_000).toISOString() });
    await act(async () => {
      answer(body({ items: [running], recent: [older] }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(run.result.current).toBeNull();
    expect(done.result.current?.view.run_id).toBe('inv-7');
    expect(done.result.current?.active).toBe(true);
  });

  it('keeps a run first seen on a frame while a read was on its way', async () => {
    const run = renderHook(() => useAiRun('case-1'));
    await flush();
    let answer: (value: InvestigationsActive) => void = () => undefined;
    h.read.mockImplementation(() => new Promise<InvestigationsActive>((resolve) => (answer = resolve)));
    const sentAt = new Date(Date.now()).toISOString();
    // The stream opens and sends a read; an automatic run starts while it is on its way.
    act(() => h.onLive?.(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });
    frame(view({ run_id: 'inv-5' }));
    // The answer says what the server had when the read arrived: no run yet.
    await act(async () => {
      answer(body({ generated_at: sentAt }));
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_OFF_MS);
    });
    expect(run.result.current?.run_id).toBe('inv-5');
  });

  it('never turns a running run back to queued on a read sent before its running frame', async () => {
    const run = renderHook(() => useAiRun('case-1'));
    await flush();
    const queued = view({
      run_id: 'inv-4',
      state: 'queued',
      phase: 'queued',
      queued_at: new Date(T0 - 5000).toISOString(),
      started_at: null,
      deadline_at: null,
    });
    frame(queued);
    expect(run.result.current?.state).toBe('queued');
    let answer: (value: InvestigationsActive) => void = () => undefined;
    h.read.mockImplementation(() => new Promise<InvestigationsActive>((resolve) => (answer = resolve)));
    act(() => h.onLive?.(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });
    frame(view({ run_id: 'inv-4', queued_at: queued.queued_at }));
    expect(run.result.current?.state).toBe('running');
    await act(async () => {
      answer(body({ items: [queued], generated_at: new Date(T0).toISOString() }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(run.result.current?.state).toBe('running');
    // A later read is the newer word again.
    h.read.mockResolvedValue(body({ items: [view({ run_id: 'inv-4', phase: 'evidence', queued_at: queued.queued_at })] }));
    act(() => h.onEvent?.({ type: 'overflow', data: {}, lastEventId: '' }));
    await flush();
    expect(run.result.current?.phase).toBe('evidence');
  });

  it('shows at once, as yours, a run whose first frame came before its 202', async () => {
    const run = renderHook(() => useAiRun('case-1'));
    await flush();
    h.read.mockResolvedValue(body({ items: [view({ run_id: 'inv-6', trigger: 'manual' })] }));
    frame(view({ run_id: 'inv-6', trigger: 'manual' }));
    // The frame asks the route who started the run; the run is still inside its hold-off.
    await flush();
    expect(run.result.current).toBeNull();
    act(() => noteReinvestigationStarted('case-1', 'inv-6'));
    expect(run.result.current).toMatchObject({ run_id: 'inv-6', state: 'running', requested_by_you: true });
  });

  it('counts the cases of a selection that have a run', async () => {
    const count = renderHook(() => useAiRunCount(['case-1', 'case-2', 'case-3']));
    await flush();
    frame(view({ run_id: 'a', case_id: 'case-1', queued_at: new Date(T0 - 5000).toISOString() }));
    frame(view({ run_id: 'b', case_id: 'case-3', queued_at: new Date(T0 - 5000).toISOString() }));
    frame(view({ run_id: 'c', case_id: 'case-9', queued_at: new Date(T0 - 5000).toISOString() }));
    expect(count.result.current).toBe(2);
  });

  it('ignores a frame that is not a run, and a run with no case', async () => {
    renderHook(() => useAiRun('case-1'));
    await flush();
    frame({ run_id: 'x', state: 'thinking', phase: 'triage', trigger: 'automatic' });
    frame(view({ case_id: null }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_OFF_MS);
    });
    expect(investigationSnapshot().byCase.size).toBe(0);
    expect(parseRun({ run_id: 'x' })).toBeNull();
  });

  it('stops asking after a refusal, and clears everything when its last reader leaves', async () => {
    h.read.mockRejectedValue(Object.assign(new Error('nope'), { status: 403 }));
    const reader = renderHook(() => useAiRun('case-1'));
    await flush();
    frame(view({ queued_at: new Date(T0 - 5000).toISOString() }));
    expect(investigationSnapshot().byCase.size).toBe(1);
    act(() => h.onLive?.(true));
    await flush();
    expect(h.read).toHaveBeenCalledTimes(1);
    reader.unmount();
    expect(h.unsubscribed).toBe(1);
    expect(investigationSnapshot().byCase.size).toBe(0);
  });

  it('keeps the navigation count: it loads and holds the store, and clears with it', async () => {
    const nav = renderHook(({ on }) => useAiCaseCount(on), { initialProps: { on: true } });
    // The hook loads the store with a dynamic import (a few turns, no timer).
    for (let i = 0; i < 50 && !h.topics.length; i += 1) await flush();
    expect(h.topics).toEqual([['investigations']]);
    frame(view({ queued_at: new Date(T0 - 5000).toISOString() }));
    frame(view({ run_id: 'inv-2', case_id: 'case-2', queued_at: new Date(T0 - 5000).toISOString() }));
    expect(nav.result.current).toBe(2);
    frame(view({ state: 'finished', outcome: 'decided' }));
    expect(nav.result.current).toBe(1);
    // Without cases:read the count is 0 and the store is let go (its last reader left).
    nav.rerender({ on: false });
    expect(nav.result.current).toBe(0);
    expect(h.unsubscribed).toBe(1);
    expect(investigationSnapshot().byCase.size).toBe(0);
  });

  it('does not subscribe for a reader that may not read cases', async () => {
    renderHook(() => useInvestigations((s) => s.byCase.size, false));
    await flush();
    expect(h.topics).toEqual([]);
    expect(h.read).not.toHaveBeenCalled();
  });
});
