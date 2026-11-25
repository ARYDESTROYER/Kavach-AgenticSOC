/**
 * One stream per page (Round 16 SPEC §4.5 WP09, the multiplexer).
 *
 * * N hooks share ONE EventSource over the union of their topics.
 * * A change of the union is debounced, reopens with `lastEventId`, and the old stream
 *   closes only once the new one is open (no gap; covered hooks stay live).
 * * The last unsubscribe closes it.
 * * Frames are routed by channel (`CHANNEL_TOPICS`): the bell never sees `case.changed`
 *   or `agent.step`, and a case-room hook never sees another case's frames.
 * * A frame published on three topics reaches a hook subscribed to all three once, and
 *   a frame both streams deliver during the swap is delivered once (deduped by id).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import {
  CHANNEL_TOPICS,
  STREAM_CHANNELS,
  frameIsFor,
  subscribeEvents,
  useEventStream,
  type StreamEvent,
} from '../useEventStream';

class MockEventSource {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 2;
  static instances: MockEventSource[] = [];

  url: string;
  readyState = MockEventSource.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  listeners = new Map<string, Array<(ev: unknown) => void>>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), cb]);
  }

  close() {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
  }

  emitOpen() {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.({});
  }

  emit(type: string, data: unknown, id: string) {
    const ev = { type, data: JSON.stringify(data), lastEventId: id } as unknown;
    for (const cb of this.listeners.get(type) || []) cb(ev);
  }

  topics(): string[] {
    const query = new URL(this.url, 'http://x').searchParams.get('topics') || '';
    return query.split(',').filter(Boolean);
  }

  lastEventId(): string | null {
    return new URL(this.url, 'http://x').searchParams.get('lastEventId');
  }
}

const open = () => MockEventSource.instances.filter((es) => !es.closed);

function probe200() {
  return { status: 200, ok: true, headers: { get: () => 'text/event-stream' } } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  fetchMock = vi.fn().mockResolvedValue(probe200());
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Mount one hook per topic list; each records the frames it receives. */
function mountHooks(lists: string[][]) {
  const got = lists.map(() => [] as StreamEvent[]);
  const view = renderHook(
    ({ sets }: { sets: string[][] }) =>
      sets.map((topics, i) => useEventStream(topics, { enabled: true, onEvent: (ev) => got[i].push(ev) }).live),
    { initialProps: { sets: lists } },
  );
  return { got, view };
}

describe('one EventSource per page', () => {
  it('shares one stream across hooks, over the union of their topics', async () => {
    const { view } = mountHooks([['notifications', 'inbox', 'jobs'], ['jobs', 'chat'], ['cases', 'jobs'], ['cases:c-1']]);
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const es = MockEventSource.instances[0];
    expect(es.topics()).toEqual(['cases', 'cases:c-1', 'chat', 'inbox', 'jobs', 'notifications']);
    // One probe for the page, not one per hook.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => es.emitOpen());
    await waitFor(() => expect(view.result.current).toEqual([true, true, true, true]));
  });

  it('closes the stream with the last unsubscribe, not before', async () => {
    const first = renderHook(() => useEventStream(['jobs'], { enabled: true }));
    const second = renderHook(() => useEventStream(['jobs'], { enabled: true }));
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const es = MockEventSource.instances[0];
    act(() => es.emitOpen());
    first.unmount();
    expect(es.closed).toBe(false);
    second.unmount();
    expect(es.closed).toBe(true);
  });

  it('reopens on a union change after the debounce, with lastEventId, and closes the old stream once the new one is open', async () => {
    const bell: StreamEvent[] = [];
    renderHook(() => useEventStream(['notifications'], { enabled: true, onEvent: (ev) => bell.push(ev) }));
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const first = MockEventSource.instances[0];
    act(() => first.emitOpen());
    act(() => first.emit('inapp', { kind: 'mention' }, '41'));

    vi.useFakeTimers();
    const caseRoom = renderHook(() => useEventStream(['cases:c-9'], { enabled: true }));
    // Debounced: nothing reopens within 300 ms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(MockEventSource.instances).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(MockEventSource.instances).toHaveLength(2);
    const second = MockEventSource.instances[1];
    expect(second.topics()).toEqual(['cases:c-9', 'notifications']);
    expect(second.lastEventId()).toBe('41');
    // The old stream serves until the new one is open: no gap.
    expect(first.closed).toBe(false);
    expect(caseRoom.result.current.live).toBe(false);
    act(() => second.emitOpen());
    expect(first.closed).toBe(true);
    expect(caseRoom.result.current.live).toBe(true);
    caseRoom.unmount();
  });

  it('keeps a hook whose topics both streams carry live through the swap', async () => {
    const lives: boolean[] = [];
    const off = subscribeEvents(['jobs'], { onLive: (live) => lives.push(live) });
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    act(() => MockEventSource.instances[0].emitOpen());
    expect(lives).toEqual([true]);
    vi.useFakeTimers();
    const offCases = subscribeEvents(['cases']);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    act(() => MockEventSource.instances[1].emitOpen());
    expect(lives).toEqual([true]);
    offCases();
    off();
  });

  it('tries again when the stream for a new topic set fails before it opens, while the old one still serves', async () => {
    const offJobs = subscribeEvents(['jobs']);
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const first = MockEventSource.instances[0];
    act(() => first.emitOpen());
    vi.useFakeTimers();
    const lives: boolean[] = [];
    const offRoom = subscribeEvents(['cases:c-3'], { onLive: (live) => lives.push(live) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(MockEventSource.instances).toHaveLength(2);
    // The new stream drops before it ever opens; the old one keeps serving `jobs`.
    act(() => MockEventSource.instances[1].onerror?.({}));
    expect(first.closed).toBe(false);
    // It is tried again with backoff (2 s after one failure, plus jitter), so the case room
    // does not stay without a stream.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(MockEventSource.instances).toHaveLength(3);
    const third = MockEventSource.instances[2];
    expect(third.topics()).toEqual(['cases:c-3', 'jobs']);
    act(() => third.emitOpen());
    expect(first.closed).toBe(true);
    expect(lives[lives.length - 1]).toBe(true);
    offRoom();
    offJobs();
  });

  it('delivers a frame both streams carry during the swap once (deduped by id)', async () => {
    const got: StreamEvent[] = [];
    const off = subscribeEvents(['jobs'], { onEvent: (ev) => got.push(ev) });
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const first = MockEventSource.instances[0];
    act(() => first.emitOpen());
    vi.useFakeTimers();
    const offCases = subscribeEvents(['cases']);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const second = MockEventSource.instances[1];
    // The new stream replays frame 7 before it reports open; the old one sends it live.
    first.emit('job', { job_id: 'j-1' }, '7');
    second.emit('job', { job_id: 'j-1' }, '7');
    expect(got).toHaveLength(1);
    offCases();
    off();
  });
});

describe('routing frames by channel', () => {
  it('gives the bell no case.changed or agent.step frame, and a case room no other case', async () => {
    const { got } = mountHooks([['notifications', 'inbox', 'jobs'], ['cases:c-1'], ['cases']]);
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const es = MockEventSource.instances[0];
    act(() => es.emitOpen());
    act(() => {
      es.emit('case.changed', { case_id: 'c-1', status: 'open' }, '1');
      es.emit('agent.step', { case_id: 'c-1', step: 'router' }, '2');
      es.emit('agent.step', { case_id: 'c-2', step: 'router' }, '3');
      es.emit('case.activity', { case_id: 'c-2', kind: 'comment' }, '4');
      es.emit('inapp', { kind: 'mention' }, '5');
      es.emit('job', { job_id: 'j-1' }, '6');
      es.emit('overflow', { dropped: 3 }, '');
    });
    const [bell, room, queue] = got.map((list) => list.map((ev) => `${ev.type}:${ev.lastEventId}`));
    expect(bell).toEqual(['inapp:5', 'job:6', 'overflow:']);
    expect(room).toEqual(['agent.step:2', 'overflow:']);
    expect(queue).toEqual(['case.changed:1', 'overflow:']);
  });

  it('hands a frame on three topics to a hook subscribed to all three once', async () => {
    const { got } = mountHooks([['cases', 'cases:c-1', 'investigations']]);
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const es = MockEventSource.instances[0];
    act(() => es.emitOpen());
    act(() => es.emit('case.investigation', { case_id: 'c-1', run_id: 'inv-1', state: 'running' }, '9'));
    expect(got[0].map((ev) => ev.type)).toEqual(['case.investigation']);
  });

  it('has a row for every channel the stream listens on', () => {
    for (const channel of STREAM_CHANNELS) expect(CHANNEL_TOPICS, channel).toHaveProperty(channel);
    expect(frameIsFor(['investigations'], 'case.investigation', { case_id: 'x' })).toBe(true);
    expect(frameIsFor(['cases:x'], 'case.review', { case_id: 'x' })).toBe(true);
    expect(frameIsFor(['cases:x'], 'case.review', { case_id: 'y' })).toBe(false);
    expect(frameIsFor(['jobs'], 'case.review', { case_id: 'x' })).toBe(false);
    // A channel the table does not know reaches every hook, as it always did.
    expect(frameIsFor(['jobs'], 'some.future', null)).toBe(true);
  });
});

describe('the imperative subscription', () => {
  it('is inert without EventSource and says so', () => {
    (globalThis as unknown as { EventSource: unknown }).EventSource = undefined;
    const onLive = vi.fn();
    const off = subscribeEvents(['investigations'], { onLive });
    expect(onLive).toHaveBeenCalledWith(false);
    expect(fetchMock).not.toHaveBeenCalled();
    off();
  });

  it('reports live only while the open stream carries its topics', async () => {
    const onLive = vi.fn();
    const off = subscribeEvents(['investigations'], { onLive });
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const es = MockEventSource.instances[0];
    act(() => es.emitOpen());
    expect(onLive).toHaveBeenLastCalledWith(true);
    act(() => {
      es.readyState = MockEventSource.CONNECTING;
      es.onerror?.({});
    });
    expect(onLive).toHaveBeenLastCalledWith(false);
    expect(open()).toHaveLength(0);
    off();
  });
});
