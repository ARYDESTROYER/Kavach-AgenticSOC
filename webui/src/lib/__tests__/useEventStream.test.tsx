/**
 * useEventStream — Wave-4 live-wiring coverage.
 *
 * Pins the load-bearing GRACEFUL-FALLBACK contract (the whole point of the hook being
 * purely additive):
 *   1. DISABLED (enabled:false) → completely inert: no probe, no EventSource, live false.
 *   2. ENABLED but realtime OFF (the probe 204s) → falls back to polling: NO EventSource
 *      is opened and `live` stays false (the caller keeps polling).
 *   3. ENABLED + realtime ON (probe 200) → opens an EventSource, `live` becomes true,
 *      and a frame is decoded + handed to `onEvent`.
 *   4. An EventSource error drops `live` back to false (so the caller resumes polling).
 *
 * EventSource + fetch are mocked (jsdom has neither a real SSE transport nor a server),
 * so this exercises the hook's own state machine with no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENT_STEP_CHANNEL,
  STREAM_CHANNELS,
  useAgentSteps,
  useEventStream,
} from '../useEventStream';

/* ----------------------------------------------------------- EventSource mock */

/** A minimal controllable EventSource stand-in matching the bits the hook uses. */
class MockEventSource {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 2;
  static instances: MockEventSource[] = [];

  url: string;
  withCredentials: boolean;
  readyState = MockEventSource.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  listeners = new Map<string, Array<(ev: unknown) => void>>();
  closed = false;

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = Boolean(init?.withCredentials);
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: unknown) => void) {
    const list = this.listeners.get(type) || [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  close() {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
  }

  /* test helpers ---------------------------------------------------------- */
  emitOpen() {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.({});
  }

  emit(type: string, data: string, id = '1') {
    const ev = { type, data, lastEventId: id } as unknown;
    for (const cb of this.listeners.get(type) || []) cb(ev);
  }

  emitError(open = false) {
    this.readyState = open ? MockEventSource.OPEN : MockEventSource.CLOSED;
    this.onerror?.({});
  }
}

/** Resolve a fetch probe with a given status (no body is ever read by the hook). */
function probeResponse(status: number) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => 'text/event-stream' },
  } as unknown as Response;
}

describe('useEventStream (Wave-4 live wiring / graceful fallback)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    MockEventSource.instances = [];
    // jsdom lacks EventSource + AbortController quirks; inject our mock.
    (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
    fetchMock = vi.fn();
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('is completely inert when disabled (no probe, no EventSource, live false)', () => {
    const onEvent = vi.fn();
    const { result } = renderHook(() =>
      useEventStream(['notifications'], { enabled: false, onEvent }),
    );
    expect(result.current.live).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('is inert when enabled but given no topics', () => {
    const { result } = renderHook(() => useEventStream([], { enabled: true }));
    expect(result.current.live).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('falls back to polling when realtime is disabled (probe 204 → no EventSource, live false)', async () => {
    fetchMock.mockResolvedValue(probeResponse(204));
    const { result } = renderHook(() =>
      useEventStream(['notifications', 'inbox'], { enabled: true }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // The probe URL carries the (sorted) topics.
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/events?topics=');
    // 204 → graceful fallback: no stream opened, live never becomes true.
    expect(MockEventSource.instances).toHaveLength(0);
    expect(result.current.live).toBe(false);
  });

  it('opens an EventSource and goes live when realtime is enabled (probe 200), delivering frames', async () => {
    fetchMock.mockResolvedValue(probeResponse(200));
    const onEvent = vi.fn();
    const { result } = renderHook(() =>
      useEventStream(['notifications'], { enabled: true, onEvent }),
    );

    // The probe resolves → the hook opens a (mock) EventSource.
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const es = MockEventSource.instances[0];
    expect(es.withCredentials).toBe(true); // cookie auth flows even under CORS

    act(() => es.emitOpen());
    await waitFor(() => expect(result.current.live).toBe(true));

    // A decoded `inapp` frame is handed to the caller verbatim (JSON-parsed).
    act(() => es.emit('inapp', JSON.stringify({ kind: 'mention', case_id: 'c-1' }), '7'));
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'inapp',
        data: { kind: 'mention', case_id: 'c-1' },
        lastEventId: '7',
      }),
    );
  });

  it('drops live back to false on an EventSource error (caller resumes polling)', async () => {
    fetchMock.mockResolvedValue(probeResponse(200));
    const { result } = renderHook(() =>
      useEventStream(['cases:case-1'], { enabled: true }),
    );

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const es = MockEventSource.instances[0];
    act(() => es.emitOpen());
    await waitFor(() => expect(result.current.live).toBe(true));

    // A transport error (stream was open then dropped) → live false again.
    act(() => es.emitError(true));
    await waitFor(() => expect(result.current.live).toBe(false));
    // The errored source is closed (no leaked socket).
    expect(es.closed).toBe(true);
  });

  it('bounds the reconnect loop (does not thrash) when a 200 probe opens a stream that never confirms open', async () => {
    // Regression: coldFailures used to reset on EVERY 200 probe (before the
    // EventSource confirmed open), so a 200-but-unstreamable endpoint (a proxy that
    // buffers text/event-stream, a backend that accepts then immediately closes)
    // looped forever: probe 200 → reset → open → onerror → reset → … The give-up cap
    // (MAX_COLD_FAILURES) must now bound it, and the reset only happens on a confirmed
    // open/frame. MAX_COLD_FAILURES is 4 (module-private), so exactly 4 streams open.
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(probeResponse(200));
    const { result } = renderHook(() =>
      useEventStream(['notifications'], { enabled: true }),
    );

    for (let i = 0; i < 12; i++) {
      // Flush the pending probe .then → open the i-th (mock) stream.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const es = MockEventSource.instances[MockEventSource.instances.length - 1];
      if (!es || es.closed) break; // no fresh stream opened → the give-up cap engaged
      // The opened stream errors BEFORE it ever confirmed OPEN (a cold failure).
      act(() => es.emitError(false));
      // Run the backoff timer so the next reconnect (if any) fires.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60000);
      });
    }

    // Bounded at the cold-failure cap (4) — not an unbounded reconnect storm.
    expect(MockEventSource.instances).toHaveLength(4);
    expect(result.current.live).toBe(false);
    // And no further reconnect remains pending after the cap engages.
    const settled = MockEventSource.instances.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120000);
    });
    expect(MockEventSource.instances).toHaveLength(settled);
  });

  it('does not retry after a 204 even if the success-path abort rejects into .catch (some runtimes)', async () => {
    // Regression: on a 204 (realtime disabled) `es` stays null, so the old
    // `.catch` guard `if (es) return` did NOT cover it — a success-path abort that
    // rejects into `.catch` (as the code notes happens in some runtimes) would run
    // coldFailures++/scheduleReconnect and re-probe a deliberately-disabled backend.
    // The probeResolved guard must keep the documented 204 "no retries" contract.
    vi.useFakeTimers();
    // A pathological thenable: fulfils with a 204 (handled in `.then`, no retry) AND
    // then rejects (the success-path ctrl.abort() surfacing into the chained `.catch`).
    const pathological = {
      then(onFulfilled: (r: Response) => unknown) {
        onFulfilled(probeResponse(204));
        return Promise.reject(new Error('The operation was aborted'));
      },
    };
    fetchMock.mockReturnValue(pathological);

    const { result } = renderHook(() =>
      useEventStream(['notifications'], { enabled: true }),
    );

    // Flush the rejected-promise microtask (the `.catch`) + any backoff timers.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });

    // 204 = realtime disabled → no stream, live false, and CRUCIALLY no retry probe.
    expect(MockEventSource.instances).toHaveLength(0);
    expect(result.current.live).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tears down (closes the stream + clears live) on unmount', async () => {
    fetchMock.mockResolvedValue(probeResponse(200));
    const { result, unmount } = renderHook(() =>
      useEventStream(['notifications'], { enabled: true }),
    );
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const es = MockEventSource.instances[0];
    act(() => es.emitOpen());
    await waitFor(() => expect(result.current.live).toBe(true));

    unmount();
    expect(es.closed).toBe(true);
  });
});


/* ------------------------------------------------- A4: the dead agent-step channel */

/**
 * The channel-name contract, from both ends.
 *
 * An `EventSource` matches a typed `event:` field by EXACT string. This list carried
 * `agent` while the backend producer publishes `agent.step`, and nothing on either side
 * can observe that kind of mismatch: the publish succeeds, the subscription succeeds,
 * and the frames are silently never delivered. So the investigation-progress channel
 * had never delivered a single frame. These tests read the backend's own registry off
 * disk so the two ends cannot drift apart again.
 */
describe('SSE channel names (A4)', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const REALTIME_PY = resolve(HERE, '../../../../backend/app/realtime.py');

  it('listens on the exact channel the pipeline publishes', () => {
    expect(AGENT_STEP_CHANNEL).toBe('agent.step');
    expect(STREAM_CHANNELS).toContain('agent.step');
    // The defect, pinned: the bare `agent` token matched nothing the backend emits.
    expect(STREAM_CHANNELS).not.toContain('agent');
  });

  it('covers every typed channel the backend registry declares', (ctx) => {
    // A REAL skip, not a silent pass, if the backend tree is not checked out alongside
    // the webui (the CI lanes always have both). An early `return` inside an `it()` body
    // reports the test as PASSED — which is exactly the silent success this drift guard
    // exists to eliminate, so it must not be how the guard itself opts out.
    if (!existsSync(REALTIME_PY)) return ctx.skip();
    const py = readFileSync(REALTIME_PY, 'utf8');
    const declared = [...py.matchAll(/^[A-Z][A-Z0-9_]*_EVENT\s*=\s*"([^"]+)"/gm)].map(
      (m) => m[1],
    );
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      expect(STREAM_CHANNELS as readonly string[]).toContain(name);
    }
  });
});

describe('useAgentSteps (A4 consumer)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    MockEventSource.instances = [];
    (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
    fetchMock = vi.fn();
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is inert without a case id', () => {
    const { result } = renderHook(() => useAgentSteps(null));
    expect(result.current.steps).toEqual([]);
    expect(result.current.live).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('subscribes to the case room and accumulates agent.step frames', async () => {
    fetchMock.mockResolvedValue(probeResponse(200));
    const { result } = renderHook(() => useAgentSteps('case-0001'));

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    expect(MockEventSource.instances[0].url).toContain(
      `topics=${encodeURIComponent('cases:case-0001')}`,
    );
    const es = MockEventSource.instances[0];
    act(() => es.emitOpen());
    await waitFor(() => expect(result.current.live).toBe(true));

    act(() =>
      es.emit(
        'agent.step',
        JSON.stringify({ case_id: 'case-0001', step: 'triage', status: 'running' }),
        '1',
      ),
    );
    act(() =>
      es.emit(
        'agent.step',
        JSON.stringify({ case_id: 'case-0001', step: 'tools', detail: 'investigation running' }),
        '2',
      ),
    );

    await waitFor(() => expect(result.current.steps).toHaveLength(2));
    expect(result.current.steps.map((s) => s.step)).toEqual(['triage', 'tools']);
    // An absent status defaults to `running`; detail is carried as plain text.
    expect(result.current.steps[1].status).toBe('running');
    expect(result.current.steps[1].detail).toBe('investigation running');
  });

  it('ignores other channels and frames naming a different case', async () => {
    fetchMock.mockResolvedValue(probeResponse(200));
    const { result } = renderHook(() => useAgentSteps('case-0001'));
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const es = MockEventSource.instances[0];
    act(() => es.emitOpen());

    act(() => es.emit('case.activity', JSON.stringify({ case_id: 'case-0001' }), '1'));
    act(() =>
      es.emit('agent.step', JSON.stringify({ case_id: 'case-9999', step: 'tools' }), '2'),
    );
    act(() => es.emit('agent.step', JSON.stringify({ case_id: 'case-0001' }), '3'));

    expect(result.current.steps).toEqual([]);
  });

  it('bounds the buffer and clears it when the case changes', async () => {
    fetchMock.mockResolvedValue(probeResponse(200));
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useAgentSteps(id, { limit: 3 }),
      { initialProps: { id: 'case-0001' } },
    );
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const es = MockEventSource.instances[0];
    act(() => es.emitOpen());

    for (let i = 0; i < 5; i++) {
      act(() =>
        es.emit('agent.step', JSON.stringify({ case_id: 'case-0001', step: `s${i}` }), String(i)),
      );
    }
    await waitFor(() => expect(result.current.steps).toHaveLength(3));
    expect(result.current.steps.map((s) => s.step)).toEqual(['s2', 's3', 's4']);

    rerender({ id: 'case-0002' });
    await waitFor(() => expect(result.current.steps).toEqual([]));
  });
});
