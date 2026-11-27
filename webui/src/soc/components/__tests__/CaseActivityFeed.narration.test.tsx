/**
 * The live narration ends (Round 16 SPEC §4.5 WP09, research ai-investigating R3): a
 * `decision` step that is `done` or `failed` turns the heading into "Investigation
 * finished", and the next run's `router` step clears the old steps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';

import { CaseActivityFeed, narrationFinished } from '@/soc/components/CaseActivityFeed';

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
    this.listeners.set(type, [...(this.listeners.get(type) || []), cb]);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  emitOpen() {
    this.readyState = 1;
    this.onopen?.({});
  }

  emit(type: string, data: unknown, id: string) {
    for (const cb of this.listeners.get(type) || []) cb({ data: JSON.stringify(data), lastEventId: id });
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  (globalThis as unknown as { fetch: unknown }).fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function mount() {
  render(<CaseActivityFeed items={[]} loading={false} liveCaseId="case-0001" onLiveActivity={vi.fn()} />);
  await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
  const es = MockEventSource.instances[0];
  act(() => es.emitOpen());
  return es;
}

const step = (step: string, status: string, detail = '') => ({ case_id: 'case-0001', step, status, detail });

describe('the live narration', () => {
  it('says "Investigation finished" after the decision step, then clears on the next run', async () => {
    const es = await mount();
    act(() => es.emit('agent.step', step('router', 'running'), '1'));
    act(() => es.emit('agent.step', step('verdict', 'running'), '2'));
    expect(screen.getByLabelText('Investigation in progress')).toBeInTheDocument();
    act(() => es.emit('agent.step', step('decision', 'done', 'needs_human'), '3'));
    const finished = screen.getByLabelText('Investigation finished');
    expect(within(finished).getByText('Investigation finished')).toBeInTheDocument();
    expect(within(finished).getAllByRole('listitem')).toHaveLength(3);
    // The next run starts with its router step: the last run's steps go.
    act(() => es.emit('agent.step', step('router', 'running'), '4'));
    const fresh = screen.getByLabelText('Investigation in progress');
    expect(within(fresh).getAllByRole('listitem')).toHaveLength(1);
  });

  it('ends a failed run too', async () => {
    const es = await mount();
    act(() => es.emit('agent.step', step('router', 'running'), '1'));
    act(() => es.emit('agent.step', step('decision', 'failed', 'needs_human'), '2'));
    expect(screen.getByLabelText('Investigation finished')).toBeInTheDocument();
  });

  it('knows a run ended only from its last step', () => {
    const at = (s: string, status: string) => ({ caseId: 'c', step: s, status, detail: '', receivedAt: 0 });
    expect(narrationFinished([])).toBe(false);
    expect(narrationFinished([at('router', 'running'), at('decision', 'done')])).toBe(true);
    expect(narrationFinished([at('decision', 'running')])).toBe(false);
    expect(narrationFinished([at('decision', 'done'), at('router', 'running')])).toBe(false);
  });
});
