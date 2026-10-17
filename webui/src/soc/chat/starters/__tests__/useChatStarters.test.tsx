/**
 * useChatStarters and useStarterViewed (SPEC-chat §3.10): a per-principal 60 s module
 * cache, every request aborted on unmount and key change, no request while disabled,
 * the 120 s refresh only while the page is visible, a focus refresh only after
 * `expires_at`, fresh results held while the analyst points at or focuses the cards,
 * the error only when nothing is shown, the session's hidden cards, and `viewed`
 * posted once per stack or thread (after 2 visible seconds or on the first send).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import type { StarterSurface } from '@/lib/types';
import {
  STARTERS_REFRESH_MS,
  STARTERS_VIEWED_AFTER_MS,
  clearChatStartersCache,
  hideStarterLocally,
  restoreStarterLocally,
  useChatStarters,
  useHiddenStarterKeys,
  useStarterViewed,
  type UseStarterViewedArgs,
} from '../useChatStarters';
import { NEEDS_HUMAN, TRIAGE, json, makeInfo, query, stubStarterFetch, type StarterCall } from './fixtures';

let visibility: DocumentVisibilityState = 'visible';

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  clearChatStartersCache();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A reply that waits until the request is aborted (then rejects like fetch does). */
function hang(call: StarterCall): Promise<Response> {
  return new Promise((_, reject) => {
    call.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
}

interface HookProps {
  principal?: string | null;
  conversationId?: string | null;
  enabled?: boolean;
  poll?: boolean;
  surface?: StarterSurface;
}

function renderStarters(initial: HookProps = {}) {
  return renderHook(
    ({ principal = 'alice', conversationId = null, enabled = true, poll = false, surface = 'home' }: HookProps) =>
      useChatStarters({ surface, conversationId, principal, enabled, poll }),
    { initialProps: initial },
  );
}

describe('useChatStarters', () => {
  it('shares a fresh answer across mounts of one principal, and nothing across principals', async () => {
    const server = stubStarterFetch(() => json(makeInfo()));
    const first = renderStarters({ principal: 'alice' });
    await waitFor(() => expect(first.result.current.info?.starters).toHaveLength(6));
    first.unmount();
    const again = renderStarters({ principal: 'alice' });
    expect(again.result.current.info?.starters).toHaveLength(6);
    expect(server.reads()).toHaveLength(1);
    again.unmount();

    const other = renderStarters({ principal: 'bob' });
    // Another viewer never sees the first viewer's cards, even for a render.
    expect(other.result.current.info).toBeNull();
    await waitFor(() => expect(other.result.current.info).not.toBeNull());
    expect(server.reads()).toHaveLength(2);
    other.unmount();
    // Seeing a different principal dropped the first viewer's entries too.
    const back = renderStarters({ principal: 'alice' });
    expect(back.result.current.info).toBeNull();
    await waitFor(() => expect(server.reads()).toHaveLength(3));
  });

  it('keeps an unidentified caller private to its own instance', async () => {
    const server = stubStarterFetch(() => json(makeInfo()));
    const first = renderStarters({ principal: null });
    await waitFor(() => expect(first.result.current.info).not.toBeNull());
    first.unmount();
    renderStarters({ principal: null });
    await waitFor(() => expect(server.reads()).toHaveLength(2));
  });

  it('makes no request while disabled', async () => {
    const server = stubStarterFetch(() => json(makeInfo()));
    const { result } = renderStarters({ enabled: false });
    await act(async () => {});
    expect(server.calls).toHaveLength(0);
    expect(result.current).toMatchObject({ info: null, loading: false, error: null });
  });

  it('aborts the read on unmount and on a key change', async () => {
    const server = stubStarterFetch(hang);
    const { rerender, unmount } = renderStarters({ surface: 'thread', conversationId: 'c-1' });
    await waitFor(() => expect(server.reads()).toHaveLength(1));
    rerender({ surface: 'thread', conversationId: 'c-2' });
    await waitFor(() => expect(server.reads()).toHaveLength(2));
    expect(server.reads()[0].signal?.aborted).toBe(true);
    expect(query(server.reads()[1]).get('conversation_id')).toBe('c-2');
    unmount();
    expect(server.reads()[1].signal?.aborted).toBe(true);
  });

  it('reads again every 120 s while the page is visible, and not while it is hidden', async () => {
    vi.useFakeTimers();
    const server = stubStarterFetch(() => json(makeInfo()));
    renderStarters({ poll: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(server.reads()).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTERS_REFRESH_MS);
    });
    expect(server.reads()).toHaveLength(2);
    act(() => setVisibility('hidden'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTERS_REFRESH_MS * 3);
    });
    expect(server.reads()).toHaveLength(2);
    act(() => setVisibility('visible'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTERS_REFRESH_MS);
    });
    expect(server.reads()).toHaveLength(3);
  });

  it('refreshes on window focus only once the answer has expired', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    let expiresAt = future;
    const server = stubStarterFetch(() => json(makeInfo({ expires_at: expiresAt })));
    const { result } = renderStarters();
    await waitFor(() => expect(result.current.info).not.toBeNull());
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => {});
    expect(server.reads()).toHaveLength(1);

    clearChatStartersCache();
    expiresAt = past;
    const second = renderStarters({ principal: 'carol' });
    await waitFor(() => expect(second.result.current.info?.expires_at).toBe(past));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(server.reads().length).toBeGreaterThanOrEqual(3));
  });

  it('holds a fresh answer while the analyst points at the cards, and applies it on release', async () => {
    vi.useFakeTimers();
    let round = 0;
    stubStarterFetch(() => {
      round += 1;
      return json(makeInfo({ starters: round === 1 ? [NEEDS_HUMAN, TRIAGE] : [TRIAGE] }));
    });
    const { result } = renderStarters({ poll: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.info?.starters.map((s) => s.id)).toEqual(['needs_human', 'triage']);
    act(() => result.current.setHeld(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTERS_REFRESH_MS);
    });
    // Never reorder under the analyst.
    expect(result.current.info?.starters.map((s) => s.id)).toEqual(['needs_human', 'triage']);
    act(() => result.current.setHeld(false));
    expect(result.current.info?.starters.map((s) => s.id)).toEqual(['triage']);
  });

  it('shows the error only while nothing is on screen, and Retry reads again', async () => {
    let fail = true;
    const server = stubStarterFetch(() => (fail ? json({ detail: 'Suggestions are down.' }, 503) : json(makeInfo())));
    const { result } = renderStarters();
    await waitFor(() => expect(result.current.error).toBe('Suggestions are down.'));
    expect(result.current.loading).toBe(false);
    fail = false;
    act(() => result.current.retry());
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.info).not.toBeNull());
    expect(server.reads()).toHaveLength(2);
    // A failed refresh keeps the cards.
    fail = true;
    act(() => result.current.retry());
    await waitFor(() => expect(server.reads()).toHaveLength(3));
    await act(async () => {});
    expect(result.current.info).not.toBeNull();
    expect(result.current.error).toBeNull();
  });
});

describe('locally hidden cards', () => {
  it('hides at once, restores on Undo, and forgets everything for another principal', async () => {
    stubStarterFetch(() => json(makeInfo()));
    const hidden = renderHook(() => useHiddenStarterKeys());
    act(() => hideStarterLocally(NEEDS_HUMAN.key as string));
    expect(hidden.result.current.has(NEEDS_HUMAN.key as string)).toBe(true);
    act(() => restoreStarterLocally(NEEDS_HUMAN.key as string));
    expect(hidden.result.current.has(NEEDS_HUMAN.key as string)).toBe(false);
    act(() => hideStarterLocally(NEEDS_HUMAN.key as string));
    // A new viewer in the same tab starts clean.
    renderStarters({ principal: 'alice' });
    renderStarters({ principal: 'bob' });
    await act(async () => {});
    expect(hidden.result.current.size).toBe(0);
  });
});

describe('useStarterViewed', () => {
  function renderViewed(initial: Partial<UseStarterViewedArgs>) {
    return renderHook((props: Partial<UseStarterViewedArgs>) =>
      useStarterViewed({ target: null, surface: 'home', enabled: true, ready: true, keys: () => ['3cf51d4967fc61e9'], ...props }),
    { initialProps: initial });
  }

  it('posts once per stack after 2 visible seconds, with the keys shown', async () => {
    vi.useFakeTimers();
    const server = stubStarterFetch(() => json(makeInfo()));
    const { rerender } = renderViewed({ target: 'home:1' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTERS_VIEWED_AFTER_MS - 1);
    });
    expect(server.events()).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(server.events()).toEqual([{ type: 'viewed', surface: 'home', keys: ['3cf51d4967fc61e9'] }]);
    rerender({ target: 'home:1' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTERS_VIEWED_AFTER_MS * 2);
    });
    expect(server.events()).toHaveLength(1);
    // Another stack (a new chat) is another view; a thread carries no keys.
    rerender({ target: 'thread:c-1', surface: 'thread' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTERS_VIEWED_AFTER_MS);
    });
    expect(server.events()[1]).toEqual({ type: 'viewed', surface: 'thread', keys: [] });
  });

  it('counts only visible time, waits for the cards, and posts nothing while off', async () => {
    vi.useFakeTimers();
    const server = stubStarterFetch(() => json(makeInfo()));
    const { rerender } = renderViewed({ target: 'home:2', ready: false });
    act(() => setVisibility('hidden'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTERS_VIEWED_AFTER_MS * 3);
    });
    act(() => setVisibility('visible'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTERS_VIEWED_AFTER_MS);
    });
    // Due, but the cards are still loading.
    expect(server.events()).toHaveLength(0);
    rerender({ target: 'home:2', ready: true });
    await act(async () => {});
    expect(server.events()).toHaveLength(1);

    rerender({ target: 'home:3', enabled: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTERS_VIEWED_AFTER_MS * 2);
    });
    expect(server.events()).toHaveLength(1);
  });

  it('posts at once on the first send, also for the stack the send just replaced', async () => {
    vi.useFakeTimers();
    const server = stubStarterFetch(() => json(makeInfo()));
    const { result, rerender } = renderViewed({ target: 'home:4' });
    // The send replaces the stack (its target ends), then the host flushes.
    rerender({ target: null });
    act(() => result.current());
    await act(async () => {});
    expect(server.events()).toEqual([{ type: 'viewed', surface: 'home', keys: ['3cf51d4967fc61e9'] }]);
    // Once only.
    act(() => result.current());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTERS_VIEWED_AFTER_MS * 2);
    });
    expect(server.events()).toHaveLength(1);
  });

  it('does not count a stack the viewer left long before a send', async () => {
    vi.useFakeTimers();
    const server = stubStarterFetch(() => json(makeInfo()));
    const { result, rerender } = renderViewed({ target: 'home:5' });
    rerender({ target: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    act(() => result.current());
    await act(async () => {});
    expect(server.events()).toHaveLength(0);
  });
});
