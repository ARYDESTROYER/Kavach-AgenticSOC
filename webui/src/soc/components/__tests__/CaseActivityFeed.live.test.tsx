/**
 * CaseActivityFeed — the RENDERED consumer of the `agent.step` channel (A4).
 *
 * The channel-name fix alone left the feature inert at the product level: frames were
 * published by the pipeline, subscribed by the transport and handed to this component's
 * `onEvent` — which dropped everything that was not `case.activity`. No rendered surface
 * had ever drawn one. These specs pin that a well-formed `agent.step` frame reaches the
 * DOM, on the SAME single subscription the activity nudge already uses (a second
 * `EventSource` on one case room would spend a browser connection slot for nothing).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, cleanup } from '@testing-library/react';

import { CaseActivityFeed } from '@/soc/components/CaseActivityFeed';

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  listeners = new Map<string, Array<(ev: unknown) => void>>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: unknown) => void) {
    const list = this.listeners.get(type) || [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  emitOpen() {
    this.readyState = 1;
    this.onopen?.({});
  }

  emit(type: string, data: string, id = '1') {
    for (const cb of this.listeners.get(type) || []) cb({ data, lastEventId: id });
  }
}

function probeResponse(status: number) {
  return { ok: status >= 200 && status < 300, status } as Response;
}

describe('CaseActivityFeed live agent steps (A4)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    MockEventSource.instances = [];
    (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
    fetchMock = vi.fn().mockResolvedValue(probeResponse(200));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  async function mountLive(onLiveActivity = vi.fn()) {
    render(
      <CaseActivityFeed
        items={[]}
        loading={false}
        liveCaseId="case-0001"
        onLiveActivity={onLiveActivity}
      />,
    );
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const es = MockEventSource.instances[0];
    act(() => es.emitOpen());
    return { es, onLiveActivity };
  }

  it('renders an agent.step frame instead of dropping it', async () => {
    const { es } = await mountLive();
    // Before any frame the empty state stands.
    expect(screen.getByText(/No activity yet/i)).toBeTruthy();

    act(() =>
      es.emit(
        'agent.step',
        JSON.stringify({
          case_id: 'case-0001',
          step: 'tools',
          status: 'running',
          detail: 'es_query',
        }),
        '1',
      ),
    );

    await waitFor(() => expect(screen.getByLabelText('Investigation in progress')).toBeTruthy());
    expect(screen.getByText('es_query')).toBeTruthy();
    expect(screen.getByText('running')).toBeTruthy();
  });

  it('still nudges the parent on a case.activity frame, on the SAME subscription', async () => {
    const { es, onLiveActivity } = await mountLive();
    act(() => es.emit('case.activity', JSON.stringify({ case_id: 'case-0001' }), '1'));
    expect(onLiveActivity).toHaveBeenCalledTimes(1);
    // One room, one socket.
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('ignores a frame naming a different case', async () => {
    const { es } = await mountLive();
    act(() =>
      es.emit('agent.step', JSON.stringify({ case_id: 'case-9999', step: 'tools' }), '1'),
    );
    expect(screen.queryByLabelText('Investigation in progress')).toBeNull();
  });
});
