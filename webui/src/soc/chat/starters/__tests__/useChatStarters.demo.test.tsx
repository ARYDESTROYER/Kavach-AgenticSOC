/**
 * useChatStarters across a Demo switch (PR #132 review): the Demo identity the console
 * knows (`off`, or the active run) is part of the cache identity. Leaving, entering or
 * resetting Demo drops the cached cards at once and reads the new identity's at once
 * (no wait for the 120 s refresh); a read in flight, or a result held while the analyst
 * points at the cards, for the old identity is discarded, never applied; and a card
 * hidden under one identity shows again under another, its waiting `dismissed` never
 * posted to the other side's stores.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import type { ChatStartersInfo } from '@/lib/types';

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
import {
  DISMISS_FALLBACK_MS,
  clearChatStartersCache,
  commitStarterDismissal,
  hideStarterLocally,
  useChatStarters,
  useHiddenStarterKeys,
} from '../useChatStarters';
import { NEEDS_HUMAN, NEW_CASES, json, makeInfo, stubStarterFetch, type StarterCall } from './fixtures';

const DEMO_CARD = {
  ...NEEDS_HUMAN,
  key: 'd1d1d1d1d1d1d1d1',
  prompt: 'Which cases need a person, starting with CASE-001042?',
};
const DEMO_RUN_2_CARD = { ...DEMO_CARD, key: 'd2d2d2d2d2d2d2d2', prompt: 'Which cases need a person, starting with CASE-002077?' };
const REAL_CARD = { ...NEW_CASES, key: 'a0a0a0a0a0a0a0a0', prompt: 'What came in since my last visit?' };

/** The answer the server gives for the Demo state it is in now. */
function answerFor(): ChatStartersInfo {
  const { active, run_id } = demoState.value;
  if (!active) return makeInfo({ starters: [{ ...REAL_CARD }] });
  return makeInfo({ starters: [{ ...(run_id === 'run-2' ? DEMO_RUN_2_CARD : DEMO_CARD) }] });
}

function setDemo(active: boolean, runId: string | null = null) {
  demoState.value = { active, run_id: runId };
}

const prompts = (info: ChatStartersInfo | null) => (info?.starters ?? []).map((s) => s.prompt);

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  resetChatDemoIdentityForTests();
  clearChatStartersCache();
  setDemo(false);
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderHome() {
  return renderHook(() => useChatStarters({ surface: 'home', principal: 'alice', poll: true }));
}

describe('useChatStarters across a Demo switch', () => {
  it('leaving Demo drops the run\'s cards and reads the real suggestions at once', async () => {
    setDemo(true, 'run-1');
    const server = stubStarterFetch(() => json(answerFor()));
    const view = renderHome();
    await waitFor(() => expect(prompts(view.result.current.info)).toEqual([DEMO_CARD.prompt]));
    expect(server.reads()).toHaveLength(1);

    setDemo(false);
    view.rerender();
    // Not one render with the Demo card: nothing to click until the real answer lands.
    expect(view.result.current.info).toBeNull();
    expect(view.result.current.loading).toBe(true);
    await waitFor(() => expect(prompts(view.result.current.info)).toEqual([REAL_CARD.prompt]));
    // Read at once (not at the next 120 s refresh).
    expect(server.reads()).toHaveLength(2);
  });

  it('entering Demo drops the real cards and reads the run\'s at once', async () => {
    const server = stubStarterFetch(() => json(answerFor()));
    const view = renderHome();
    await waitFor(() => expect(prompts(view.result.current.info)).toEqual([REAL_CARD.prompt]));
    setDemo(true, 'run-1');
    view.rerender();
    expect(view.result.current.info).toBeNull();
    await waitFor(() => expect(prompts(view.result.current.info)).toEqual([DEMO_CARD.prompt]));
    expect(server.reads()).toHaveLength(2);
  });

  it('a Demo reset (a new run) drops the previous run\'s cards, also for a later mount', async () => {
    setDemo(true, 'run-1');
    const server = stubStarterFetch(() => json(answerFor()));
    const first = renderHome();
    await waitFor(() => expect(prompts(first.result.current.info)).toEqual([DEMO_CARD.prompt]));
    first.unmount();
    // Reset while the chat was closed: the next mount never shows run 1's cached cards.
    setDemo(true, 'run-2');
    const again = renderHome();
    expect(again.result.current.info).toBeNull();
    await waitFor(() => expect(prompts(again.result.current.info)).toEqual([DEMO_RUN_2_CARD.prompt]));
    expect(server.reads()).toHaveLength(2);
    // Back to an identity seen before (leave, re-enter as run 1's id): still a fresh read.
    again.unmount();
    setDemo(false);
    const off = renderHome();
    expect(off.result.current.info).toBeNull();
    await waitFor(() => expect(prompts(off.result.current.info)).toEqual([REAL_CARD.prompt]));
    expect(server.reads()).toHaveLength(3);
  });

  it('never applies or caches a read that was in flight for the old identity', async () => {
    setDemo(true, 'run-1');
    const replies: Array<(r: Response) => void> = [];
    const server = stubStarterFetch(
      (call: StarterCall) =>
        new Promise<Response>((resolve, reject) => {
          replies.push(resolve);
          call.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const view = renderHome();
    await waitFor(() => expect(server.reads()).toHaveLength(1));
    setDemo(false);
    view.rerender();
    await waitFor(() => expect(server.reads()).toHaveLength(2));
    expect(server.reads()[0].signal?.aborted).toBe(true);
    // The old run's answer lands late: nothing shows it.
    await act(async () => replies[0](json(makeInfo({ starters: [{ ...DEMO_CARD }] }))));
    expect(view.result.current.info).toBeNull();
    await act(async () => replies[1](json(makeInfo({ starters: [{ ...REAL_CARD }] }))));
    await waitFor(() => expect(prompts(view.result.current.info)).toEqual([REAL_CARD.prompt]));
  });

  it('discards a result held under the pointer before the switch, even back on the same identity', async () => {
    let reply: (() => ChatStartersInfo) | null = null;
    const deferred: Array<(r: Response) => void> = [];
    const server = stubStarterFetch((call: StarterCall) => {
      if (reply) return json(reply());
      return new Promise<Response>((resolve, reject) => {
        deferred.push(resolve);
        call.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    reply = () => makeInfo({ starters: [{ ...REAL_CARD }] });
    const view = renderHome();
    await waitFor(() => expect(prompts(view.result.current.info)).toEqual([REAL_CARD.prompt]));
    // The analyst points at the cards; a refresh arrives and is held.
    const OLD_HELD = { ...REAL_CARD, key: 'a1a1a1a1a1a1a1a1', prompt: 'A card read before Demo was entered' };
    reply = () => makeInfo({ starters: [{ ...OLD_HELD }] });
    act(() => view.result.current.setHeld(true));
    act(() => view.result.current.retry());
    await waitFor(() => expect(server.reads()).toHaveLength(2));
    await act(async () => {});
    expect(prompts(view.result.current.info)).toEqual([REAL_CARD.prompt]); // held, not applied
    // Demo entered, then left again before anything new landed.
    reply = null;
    setDemo(true, 'run-1');
    view.rerender();
    setDemo(false);
    view.rerender();
    expect(view.result.current.info).toBeNull();
    // The pointer leaves: the result held before the switch is discarded.
    act(() => view.result.current.setHeld(false));
    expect(view.result.current.info).toBeNull();
    const last = deferred[deferred.length - 1];
    await act(async () => last(json(makeInfo({ starters: [{ ...REAL_CARD }] }))));
    await waitFor(() => expect(prompts(view.result.current.info)).toEqual([REAL_CARD.prompt]));
  });

  it('shows a card hidden under one identity again under another, and never posts its dismissal there', async () => {
    vi.useFakeTimers();
    setDemo(true, 'run-1');
    const server = stubStarterFetch(() => json(answerFor()));
    const view = renderHook(() => {
      const starters = useChatStarters({ surface: 'home', principal: 'alice' });
      return { starters, hidden: useHiddenStarterKeys() };
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(prompts(view.result.current.starters.info)).toEqual([DEMO_CARD.prompt]);
    act(() => {
      hideStarterLocally(DEMO_CARD.key, DEMO_CARD.key, 'alice');
    });
    expect(view.result.current.hidden.has(DEMO_CARD.key)).toBe(true);
    // Exit Demo while the "Hidden for a day" toast is still open.
    setDemo(false);
    view.rerender();
    expect(view.result.current.hidden.size).toBe(0);
    act(() => commitStarterDismissal(DEMO_CARD.key));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DISMISS_FALLBACK_MS);
    });
    expect(server.events()).toEqual([]);
  });

  it('posts a dismissal under the identity it was hidden in', async () => {
    setDemo(true, 'run-1');
    const server = stubStarterFetch(() => json(answerFor()));
    const view = renderHome();
    await waitFor(() => expect(view.result.current.info).not.toBeNull());
    act(() => {
      hideStarterLocally(DEMO_CARD.key, DEMO_CARD.key, 'alice');
    });
    act(() => commitStarterDismissal(DEMO_CARD.key));
    await waitFor(() => expect(server.events()).toEqual([{ type: 'dismissed', surface: 'home', keys: [DEMO_CARD.key] }]));
  });
});
