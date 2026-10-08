/**
 * useChatContext (SPEC §8): a 30 s per-principal cache, a fresh read on conversation /
 * model / case change and after a turn settles, `revalidate()` only past the TTL,
 * abort on unmount and on key change, nothing while disabled, and a failed refresh
 * that keeps the last good context.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  CHAT_CONTEXT_TTL_MS,
  clearChatContextCache,
  useChatContext,
  type UseChatContextArgs,
} from '../../useChatContext';

let urls: string[] = [];
let signals: AbortSignal[] = [];
let respond: (url: string) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  clearChatContextCache();
  urls = [];
  signals = [];
  respond = (url) => json({ model: `m-${urls.length}`, history_tokens: url.includes('conversation_id=c2') ? 900 : 100 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      if (init?.signal) signals.push(init.signal);
      return respond(String(input));
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const mount = (props: UseChatContextArgs) =>
  renderHook((p: UseChatContextArgs) => useChatContext(p), { initialProps: props });

describe('useChatContext', () => {
  it('loads once and serves a remount from the 30 s cache', async () => {
    const first = mount({ conversationId: null, model: null, principal: 'alice' });
    await waitFor(() => expect(first.result.current.context?.model).toBe('m-1'));
    expect(urls).toEqual(['/api/chat/context']);
    first.unmount();

    const second = mount({ conversationId: null, model: null, principal: 'alice' });
    expect(second.result.current.context?.model).toBe('m-1');
    await act(async () => {});
    expect(urls).toHaveLength(1);
  });

  it('never serves one principal the cache of another', async () => {
    const alice = mount({ conversationId: null, model: null, principal: 'alice' });
    await waitFor(() => expect(alice.result.current.context).not.toBeNull());
    alice.unmount();
    const bob = mount({ conversationId: null, model: null, principal: 'bob' });
    expect(bob.result.current.context).toBeNull();
    await waitFor(() => expect(urls).toHaveLength(2));
  });

  it('never shares entries across mounts without a known principal (fail closed)', async () => {
    const first = mount({ conversationId: null, model: null });
    await waitFor(() => expect(first.result.current.context).not.toBeNull());
    first.unmount();
    // A second caller that did not say who it is must not see the first one's data.
    const second = mount({ conversationId: null, model: null, principal: null });
    expect(second.result.current.context).toBeNull();
    await waitFor(() => expect(urls).toHaveLength(2));
    // Nor may a named principal read an unnamed instance's entry.
    second.unmount();
    const named = mount({ conversationId: null, model: null, principal: 'alice' });
    expect(named.result.current.context).toBeNull();
    await waitFor(() => expect(urls).toHaveLength(3));
  });

  it('drops every cached entry when a different principal signs in', async () => {
    const alice = mount({ conversationId: 'c1', model: null, principal: 'alice' });
    await waitFor(() => expect(alice.result.current.context).not.toBeNull());
    alice.unmount();
    const bob = mount({ conversationId: 'c1', model: null, principal: 'bob' });
    await waitFor(() => expect(bob.result.current.context).not.toBeNull());
    bob.unmount();
    // Alice again inside the 30 s window: her old entry is gone, so it is re-read.
    const again = mount({ conversationId: 'c1', model: null, principal: 'alice' });
    expect(again.result.current.context).toBeNull();
    await waitFor(() => expect(urls).toHaveLength(3));
  });

  it('drops the previous catalogue at once when the principal changes', async () => {
    const hook = mount({ conversationId: null, model: null, principal: 'alice' });
    await waitFor(() => expect(hook.result.current.context).not.toBeNull());
    let release!: () => void;
    respond = () => new Promise<Response>((resolve) => (release = () => resolve(json({ model: 'bob-model' }))));
    hook.rerender({ conversationId: null, model: null, principal: 'bob' });
    expect(hook.result.current.context).toBeNull();
    await act(async () => release());
    await waitFor(() => expect(hook.result.current.context?.model).toBe('bob-model'));
  });

  it('re-reads on conversation and model change, sending both as query params', async () => {
    const hook = mount({ conversationId: 'c1', model: null });
    await waitFor(() => expect(urls).toHaveLength(1));
    hook.rerender({ conversationId: 'c2', model: null });
    await waitFor(() => expect(hook.result.current.context?.history_tokens).toBe(900));
    hook.rerender({ conversationId: 'c2', model: 'gpt-x' });
    await waitFor(() => expect(urls).toHaveLength(3));
    expect(urls[2]).toContain('conversation_id=c2');
    expect(urls[2]).toContain('model=gpt-x');
  });

  it('refreshes past the cache when a turn settles', async () => {
    const hook = mount({ conversationId: 'c1', model: null, busy: false });
    await waitFor(() => expect(urls).toHaveLength(1));
    hook.rerender({ conversationId: 'c1', model: null, busy: true });
    await act(async () => {});
    expect(urls).toHaveLength(1);
    hook.rerender({ conversationId: 'c1', model: null, busy: false });
    await waitFor(() => expect(urls).toHaveLength(2));
  });

  it('refresh() forces a read; revalidate() only once the entry is stale', async () => {
    const hook = mount({ conversationId: null, model: null });
    await waitFor(() => expect(urls).toHaveLength(1));
    act(() => hook.result.current.revalidate());
    await act(async () => {});
    expect(urls).toHaveLength(1);
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(urls).toHaveLength(2));

    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + CHAT_CONTEXT_TTL_MS + 1);
    act(() => hook.result.current.revalidate());
    await waitFor(() => expect(urls).toHaveLength(3));
    spy.mockRestore();
  });

  it('makes no request while disabled', async () => {
    const hook = mount({ conversationId: null, model: null, enabled: false });
    await act(async () => {});
    expect(urls).toHaveLength(0);
    expect(hook.result.current.loading).toBe(false);
    hook.rerender({ conversationId: null, model: null, enabled: true });
    await waitFor(() => expect(urls).toHaveLength(1));
  });

  it('aborts the in-flight read on unmount and on key change', async () => {
    respond = () => new Promise<Response>(() => {});
    const hook = mount({ conversationId: 'c1', model: null });
    await waitFor(() => expect(signals).toHaveLength(1));
    hook.rerender({ conversationId: 'c2', model: null });
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0].aborted).toBe(true);
    hook.unmount();
    expect(signals[1].aborted).toBe(true);
  });

  it('keeps the last good context when a refresh fails', async () => {
    const hook = mount({ conversationId: null, model: null });
    await waitFor(() => expect(hook.result.current.context?.model).toBe('m-1'));
    respond = () => json({ detail: 'boom' }, 500);
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(hook.result.current.error).not.toBeNull());
    expect(hook.result.current.context?.model).toBe('m-1');
    expect(hook.result.current.loading).toBe(false);
  });
});
