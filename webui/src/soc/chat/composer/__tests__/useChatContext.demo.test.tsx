/**
 * useChatContext across a Demo switch (PR #132 review): the composer meter's context
 * (simulated rates and budget, the history estimate over the Demo run's conversations,
 * the evergreen starters with the Demo card) is cached per Demo identity too. Leaving,
 * entering or resetting Demo never shows the other side's context, not even for a
 * render, and reads afresh at once, also for a later mount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { demoState } = vi.hoisted(() => ({
  demoState: { value: { active: false, run_id: null as string | null } },
}));
vi.mock('@/soc/demo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/demo')>();
  return {
    ...actual,
    useDemo: () => {
      const { active, run_id } = demoState.value;
      const status = { mode: active ? 'seeded' : 'off', active, run_id } as const;
      return { status, active, loading: false, refresh: async () => status };
    },
  };
});

import { resetChatDemoIdentityForTests } from '../../demo-identity';
import { clearChatContextCache, useChatContext } from '../../useChatContext';

let reads = 0;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function setDemo(active: boolean, runId: string | null = null) {
  demoState.value = { active, run_id: runId };
}

beforeEach(() => {
  resetChatDemoIdentityForTests();
  clearChatContextCache();
  setDemo(false);
  reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      reads += 1;
      const { active, run_id } = demoState.value;
      return json({ model: active ? `demo-model-${run_id}` : 'real-model', simulated: active });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const mount = () => renderHook(() => useChatContext({ conversationId: null, model: null, principal: 'alice' }));

describe('useChatContext across a Demo switch', () => {
  it('leaving, entering and resetting Demo each read afresh and never show the other side', async () => {
    setDemo(true, 'run-1');
    const view = mount();
    await waitFor(() => expect(view.result.current.context?.model).toBe('demo-model-run-1'));

    setDemo(false);
    view.rerender();
    expect(view.result.current.context).toBeNull();
    await waitFor(() => expect(view.result.current.context?.model).toBe('real-model'));
    expect(view.result.current.context?.simulated).toBe(false);

    setDemo(true, 'run-2');
    view.rerender();
    expect(view.result.current.context).toBeNull();
    await waitFor(() => expect(view.result.current.context?.model).toBe('demo-model-run-2'));
    expect(reads).toBe(3);
  });

  it('a later mount after the switch never gets the previous identity\'s cached context', async () => {
    setDemo(true, 'run-1');
    const first = mount();
    await waitFor(() => expect(first.result.current.context?.model).toBe('demo-model-run-1'));
    first.unmount();
    setDemo(false);
    const second = mount();
    expect(second.result.current.context).toBeNull();
    await waitFor(() => expect(second.result.current.context?.model).toBe('real-model'));
    second.unmount();
    // Back to Demo under the same run id as before: still not the old entry (it was dropped).
    setDemo(true, 'run-1');
    const third = mount();
    expect(third.result.current.context).toBeNull();
    await waitFor(() => expect(third.result.current.context?.model).toBe('demo-model-run-1'));
    expect(reads).toBe(3);
  });
});
