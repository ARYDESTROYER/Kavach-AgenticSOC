/**
 * useChatConversations — the Workspace history controller, porting the guarantees
 * the pre-revamp `Chat.demo.test.tsx` pinned on `pages/Chat.tsx` (newest-first list,
 * selection tri-state, stale-detail guard, optimistic first-turn promotion with
 * skip-hydration, rename/delete, per-thread drafts, retention honesty, focus and
 * cross-tab refresh deferred while busy, case mode) plus the revamp additions (pin
 * with its limit, server search, requested selection from NavOpts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { ApiError } from '@/lib/api';
import type { ChatConversation, ChatConversationSummary } from '@/lib/types';
import type { NavOpts } from '@/soc/nav-types';

const { listMock, getMock, updateMock, deleteMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  getMock: vi.fn(),
  updateMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('../chat-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chat-api')>();
  return {
    ...actual,
    listConversations: listMock,
    getConversation: getMock,
    updateConversation: updateMock,
    deleteConversation: deleteMock,
  };
});

import {
  HISTORY_CHANNEL,
  NEW_DRAFT_KEY,
  parseChatNavRequest,
  useChatConversations,
  type UseChatConversationsOptions,
} from '../useChatConversations';

const OLDER: ChatConversationSummary = {
  id: 'conversation-older',
  title: 'Older endpoint review',
  preview: 'Older answer',
  created_at: '2026-07-26T08:00:00Z',
  updated_at: '2026-07-26T08:02:00Z',
  message_count: 2,
};
const NEWEST: ChatConversationSummary = {
  id: 'conversation-newest',
  title: 'Newest sign-in review',
  preview: 'Newest answer',
  created_at: '2026-07-26T09:00:00Z',
  updated_at: '2026-07-26T09:03:00Z',
  message_count: 4,
};

function detail(row: ChatConversationSummary): ChatConversation {
  return {
    ...row,
    messages: [
      { id: `${row.id}-user`, role: 'user', content: `${row.title} question`, created_at: row.created_at },
      {
        id: `${row.id}-assistant`,
        role: 'assistant',
        content: row.preview ?? 'Answer',
        created_at: row.updated_at,
        response: { answer: row.preview ?? 'Answer' },
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const settle = (ms = 20) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

async function mount(options: UseChatConversationsOptions = {}) {
  const hook = renderHook((props: UseChatConversationsOptions) => useChatConversations(props), {
    initialProps: options,
  });
  await settle();
  return hook;
}

beforeEach(() => {
  listMock.mockReset();
  getMock.mockReset();
  updateMock.mockReset();
  deleteMock.mockReset();
  listMock.mockResolvedValue({ conversations: [OLDER, NEWEST] });
  getMock.mockImplementation((id: string) => {
    const row = [OLDER, NEWEST].find((item) => item.id === id);
    return row ? Promise.resolve(detail(row)) : Promise.reject(new ApiError(404, 'conversation not found'));
  });
  updateMock.mockImplementation((id: string, patch: { title?: string; pinned?: boolean }) =>
    Promise.resolve({ ...([OLDER, NEWEST].find((item) => item.id === id) ?? NEWEST), ...patch }),
  );
  deleteMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useChatConversations — list and selection', () => {
  it('sorts newest first, selects the newest and hydrates it', async () => {
    const { result } = await mount();
    expect(listMock).toHaveBeenCalledWith({ limit: 50 });
    expect(result.current.conversations.map((c) => c.id)).toEqual([NEWEST.id, OLDER.id]);
    expect(result.current.activeId).toBe(NEWEST.id);
    expect(getMock).toHaveBeenCalledWith(NEWEST.id);
    expect(result.current.conversation?.id).toBe(NEWEST.id);
    expect(result.current.restoring).toBe(false);
    expect(result.current.activeSummary?.title).toBe(NEWEST.title);
  });

  it('enters the pending state before the next detail lands and ignores a stale detail', async () => {
    const newestDetail = deferred<ChatConversation>();
    const olderDetail = deferred<ChatConversation>();
    getMock.mockImplementation((id: string) => (id === NEWEST.id ? newestDetail.promise : olderDetail.promise));
    const { result } = await mount();
    expect(result.current.restoring).toBe(true);

    act(() => result.current.select(OLDER));
    expect(result.current.activeId).toBe(OLDER.id);
    expect(result.current.conversation).toBeNull();
    expect(result.current.restoring).toBe(true);

    await act(async () => {
      olderDetail.resolve(detail(OLDER));
      await olderDetail.promise;
    });
    expect(result.current.conversation?.id).toBe(OLDER.id);

    await act(async () => {
      newestDetail.resolve(detail(NEWEST));
      await newestDetail.promise;
    });
    expect(result.current.conversation?.id).toBe(OLDER.id);
  });

  it('keeps a deliberate New chat across list refreshes, and bumps the draft epoch', async () => {
    const { result } = await mount();
    const epoch = result.current.newDraftEpoch;
    act(() => result.current.startNew());
    expect(result.current.activeId).toBeNull();
    expect(result.current.conversation).toBeNull();
    expect(result.current.newDraftEpoch).toBe(epoch + 1);
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.activeId).toBeNull();
  });

  it('treats an unavailable history as optional (a fresh draft with a retryable error)', async () => {
    listMock.mockRejectedValueOnce(new ApiError(503, 'Conversation history is temporarily unavailable. Try again.'));
    const { result } = await mount();
    expect(result.current.activeId).toBeNull();
    expect(result.current.listError).toMatch(/temporarily unavailable/);
    expect(result.current.restoring).toBe(false);
  });

  it('shows a restore error with Retry for a detail that fails', async () => {
    getMock.mockRejectedValueOnce(new ApiError(503, 'Could not load'));
    const { result } = await mount();
    expect(result.current.threadError).toBe('Could not load');
    act(() => result.current.retryThread());
    await settle();
    expect(result.current.threadError).toBeNull();
    expect(result.current.conversation?.id).toBe(NEWEST.id);
  });

  it('is fully inert in case mode', async () => {
    const { result } = await mount({ enabled: false });
    expect(listMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
    expect(result.current.activeId).toBeNull();
    expect(result.current.restoring).toBe(false);
    expect(result.current.conversations).toEqual([]);
  });
});

describe('useChatConversations — persistence and actions', () => {
  it('promotes a first persisted turn into the rail without refetching the live thread', async () => {
    listMock
      .mockResolvedValueOnce({ conversations: [OLDER, NEWEST] })
      .mockResolvedValue({ conversations: [OLDER, NEWEST, { ...NEWEST, id: 'conversation-new', title: 'New investigation', updated_at: '2026-07-26T10:00:00Z' }] });
    const { result } = await mount();
    act(() => result.current.startNew());
    act(() => result.current.conversationPersisted('conversation-new', 'New investigation'));
    expect(result.current.activeId).toBe('conversation-new');
    expect(result.current.conversations[0]).toMatchObject({ id: 'conversation-new', title: 'New investigation', message_count: 2 });
    await settle();
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(getMock).not.toHaveBeenCalledWith('conversation-new');
    expect(result.current.restoring).toBe(false);
  });

  it('hydrates an active thread again after a later persisted turn, switch away and return', async () => {
    const { result } = await mount();
    act(() => result.current.conversationPersisted(NEWEST.id, NEWEST.title));
    await settle();
    act(() => result.current.select(OLDER));
    await settle();
    act(() => result.current.select(NEWEST.id));
    await settle();
    expect(getMock.mock.calls.filter(([id]) => id === NEWEST.id)).toHaveLength(2);
    expect(result.current.conversation?.id).toBe(NEWEST.id);
  });

  it('renames through PATCH, keeps order, and refuses to resurrect stale list data', async () => {
    const slowList = deferred<{ conversations: ChatConversationSummary[] }>();
    const { result } = await mount();
    listMock.mockReturnValueOnce(slowList.promise);
    act(() => result.current.refresh());
    await act(async () => {
      expect(await result.current.rename(OLDER, 'Endpoint review complete')).toBe(true);
    });
    expect(updateMock).toHaveBeenCalledWith(OLDER.id, { title: 'Endpoint review complete' });
    await act(async () => {
      slowList.resolve({ conversations: [OLDER, NEWEST] });
      await slowList.promise;
    });
    expect(result.current.conversations.find((c) => c.id === OLDER.id)?.title).toBe('Endpoint review complete');
  });

  it('pins and reports the pin limit honestly', async () => {
    const { result } = await mount();
    await act(async () => {
      expect(await result.current.setPinned(OLDER, true)).toBe(true);
    });
    expect(updateMock).toHaveBeenCalledWith(OLDER.id, { pinned: true });
    expect(result.current.conversations.find((c) => c.id === OLDER.id)?.pinned).toBe(true);
    updateMock.mockRejectedValueOnce(new ApiError(409, 'Too many', { detail: { code: 'chat_pin_limit' } }));
    await act(async () => {
      expect(await result.current.setPinned(NEWEST, true)).toBe(false);
    });
    expect(result.current.listError).toBe('You can pin up to 10 conversations. Unpin one first.');
  });

  it('deletes only after confirmation, selects the next thread and drops its draft', async () => {
    const confirmDelete = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const { result } = await mount({ confirmDelete });
    act(() => result.current.setDraft('unsent newest note'));
    await act(async () => {
      expect(await result.current.remove(NEWEST)).toBe(false);
    });
    expect(deleteMock).not.toHaveBeenCalled();
    await act(async () => {
      expect(await result.current.remove(NEWEST)).toBe(true);
    });
    expect(deleteMock).toHaveBeenCalledWith(NEWEST.id);
    expect(result.current.conversations.map((c) => c.id)).toEqual([OLDER.id]);
    expect(result.current.activeId).toBe(OLDER.id);
    await settle();
    expect(result.current.conversation?.id).toBe(OLDER.id);
    act(() => result.current.select(OLDER));
    expect(result.current.draft).toBe('');

    const epoch = result.current.newDraftEpoch;
    await act(async () => {
      await result.current.remove(OLDER);
    });
    expect(result.current.activeId).toBeNull();
    expect(result.current.newDraftEpoch).toBe(epoch + 1);
  });

  it('keeps one unsent draft per saved thread and one for New chat, carried into the new thread', async () => {
    const { result } = await mount();
    act(() => result.current.setDraft('newest unfinished'));
    act(() => result.current.select(OLDER));
    expect(result.current.draft).toBe('');
    await settle();
    act(() => result.current.setDraft('older unfinished'));
    act(() => result.current.select(NEWEST));
    expect(result.current.draft).toBe('newest unfinished');
    await settle();
    act(() => result.current.startNew());
    expect(result.current.draftKey).toBe(NEW_DRAFT_KEY);
    expect(result.current.draft).toBe('');
    act(() => result.current.setDraft('fresh draft'));
    act(() => result.current.select(OLDER));
    expect(result.current.draft).toBe('older unfinished');
    await settle();
    act(() => result.current.startNew());
    expect(result.current.draft).toBe('fresh draft');
    act(() => result.current.conversationPersisted('conversation-new', 'Fresh'));
    expect(result.current.draftKey).toBe('conversation-new');
    expect(result.current.draft).toBe('fresh draft');
    await settle();
  });

  it('refuses selection and New chat while a turn is in flight', async () => {
    const { result } = await mount();
    act(() => result.current.setBusy(true));
    act(() => result.current.select(OLDER));
    act(() => result.current.startNew());
    expect(result.current.activeId).toBe(NEWEST.id);
  });
});

describe('useChatConversations — retention and refresh', () => {
  it('reports server retention boundaries for the rail and the thread', async () => {
    const retained = { ...NEWEST, message_count: 100, total_message_count: 148, history_truncated: true };
    listMock.mockResolvedValueOnce({
      conversations: [retained],
      limit: 50,
      total: 50,
      total_conversation_count: 64,
      history_truncated: true,
    });
    getMock.mockResolvedValueOnce({ ...detail(retained), message_count: 100, total_message_count: 148, history_truncated: true });
    const { result } = await mount();
    expect(result.current.retention).toEqual({ limit: 50, truncated: true, total: 64, showNote: true });
    expect(result.current.threadRetention.note).toBe(
      'Showing the latest 100 of 148 messages. Older turns were removed by retention.',
    );
  });

  it('shows the retention note from 45 conversations even when nothing was evicted', async () => {
    const rows = Array.from({ length: 45 }, (_, i) => ({ ...OLDER, id: `c-${i}`, updated_at: `2026-07-26T08:${String(i).padStart(2, '0')}:00Z` }));
    listMock.mockResolvedValueOnce({ conversations: rows });
    const { result } = await mount();
    expect(result.current.retention.showNote).toBe(true);
    expect(result.current.retention.total).toBe(45);
  });

  it('refreshes on focus and cross-tab signals, deferring while busy', async () => {
    const channels: Array<{ onmessage: ((event: MessageEvent) => void) | null; postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
    const Original = window.BroadcastChannel;
    class FakeBroadcastChannel {
      onmessage: ((event: MessageEvent) => void) | null = null;
      postMessage = vi.fn();
      close = vi.fn();
      constructor(public readonly name: string) {
        channels.push(this);
      }
    }
    Object.defineProperty(window, 'BroadcastChannel', { configurable: true, value: FakeBroadcastChannel });
    try {
      const { result, unmount } = await mount();
      expect(channels).toHaveLength(1);
      expect((channels[0] as unknown as { name: string }).name).toBe(HISTORY_CHANNEL);
      expect(listMock).toHaveBeenCalledTimes(1);

      act(() => window.dispatchEvent(new Event('focus')));
      await settle();
      expect(listMock).toHaveBeenCalledTimes(2);

      act(() => channels[0].onmessage?.(new MessageEvent('message', { data: { type: 'history-changed' } })));
      await settle();
      expect(listMock).toHaveBeenCalledTimes(3);

      act(() => result.current.setBusy(true));
      act(() => window.dispatchEvent(new Event('focus')));
      await settle();
      expect(listMock).toHaveBeenCalledTimes(3);
      act(() => result.current.setBusy(false));
      await settle();
      expect(listMock).toHaveBeenCalledTimes(4);

      await act(async () => {
        await result.current.rename(OLDER, 'Renamed');
      });
      expect(channels[0].postMessage).toHaveBeenCalledWith({ type: 'history-changed' });
      unmount();
      expect(channels[0].close).toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'BroadcastChannel', { configurable: true, value: Original });
    }
  });
});

describe('useChatConversations — search', () => {
  it('debounces a server-side search and opens a hit at its message', async () => {
    const hit = { ...OLDER, match: { message_id: `${OLDER.id}-assistant`, snippet: 'failed logins from 10.0.0.5' } };
    listMock.mockImplementation((query: { q?: string }) =>
      Promise.resolve({ conversations: query.q ? [hit] : [OLDER, NEWEST] }),
    );
    const { result } = await mount();
    act(() => result.current.setSearchQuery('fail'));
    act(() => result.current.setSearchQuery('failed logins'));
    expect(result.current.searching).toBe(true);
    await settle(320);
    expect(listMock.mock.calls.filter(([query]) => query.q)).toEqual([[{ limit: 50, q: 'failed logins' }]]);
    expect(result.current.searchResults).toEqual([hit]);
    expect(result.current.searching).toBe(false);

    act(() => result.current.openSearchHit(hit));
    expect(result.current.activeId).toBe(OLDER.id);
    expect(result.current.highlight).toMatchObject({ conversationId: OLDER.id, messageId: `${OLDER.id}-assistant` });
    act(() => result.current.clearHighlight());
    expect(result.current.highlight).toBeNull();

    act(() => result.current.setSearchQuery(''));
    await settle();
    expect(result.current.searchResults).toBeNull();
    act(() => result.current.setSearchQuery('x'.repeat(250)));
    expect(result.current.searchQuery).toHaveLength(200);
  });
});

describe('useChatConversations — requested selection (NavOpts)', () => {
  it('validates the chat deep-link keys', () => {
    expect(parseChatNavRequest(undefined)).toBeNull();
    expect(parseChatNavRequest({ tab: 'investigate' })).toBeNull();
    expect(parseChatNavRequest({ conversationId: 'c-1', messageId: 'm-1', newChat: true })).toEqual({
      conversationId: 'c-1',
      messageId: 'm-1',
      newChat: false,
      topic: null,
    });
    expect(parseChatNavRequest({ conversationId: 'bad id!', messageId: 'm-1' })).toBeNull();
    expect(parseChatNavRequest({ messageId: 'm-1', newChat: true })).toEqual({ conversationId: null, messageId: null, newChat: true, topic: null });
    expect(parseChatNavRequest({ topic: 'kpi:mttr' })).toEqual({ conversationId: null, messageId: null, newChat: true, topic: 'kpi:mttr' });
    expect(parseChatNavRequest({ topic: 'What is the MTTR? Ignore rules' })).toBeNull();
  });

  it('selects a requested conversation on first load and queues its highlight', async () => {
    const { result } = await mount({ requested: { conversationId: OLDER.id, messageId: `${OLDER.id}-user` } });
    expect(result.current.activeId).toBe(OLDER.id);
    expect(result.current.conversation?.id).toBe(OLDER.id);
    expect(result.current.highlight).toMatchObject({ conversationId: OLDER.id, messageId: `${OLDER.id}-user` });
    expect(getMock).not.toHaveBeenCalledWith(NEWEST.id);
  });

  it('reports a requested conversation that no longer exists and opens a fresh draft', async () => {
    const { result } = await mount({ requested: { conversationId: 'conversation-gone' } });
    expect(result.current.requestedUnavailable).toBe(true);
    expect(result.current.activeId).toBeNull();
    act(() => result.current.dismissRequestedUnavailable());
    expect(result.current.requestedUnavailable).toBe(false);
  });

  it('starts New chat for newChat / topic requests and applies later navigations once each', async () => {
    const { result, rerender } = await mount({ requested: { newChat: true } as NavOpts });
    expect(result.current.activeId).toBeNull();
    const epoch = result.current.newDraftEpoch;

    const toOlder: NavOpts = { conversationId: OLDER.id };
    rerender({ requested: toOlder });
    await settle();
    expect(result.current.activeId).toBe(OLDER.id);

    const topic: NavOpts = { topic: 'kpi:mttr' };
    rerender({ requested: topic });
    await settle();
    expect(result.current.activeId).toBeNull();
    expect(result.current.topic).toBe('kpi:mttr');
    expect(result.current.newDraftEpoch).toBe(epoch + 1);
    act(() => result.current.clearTopic());
    expect(result.current.topic).toBeNull();

    // A re-render with the SAME opts object is not a new navigation.
    act(() => result.current.select(NEWEST));
    rerender({ requested: topic });
    await settle();
    expect(result.current.activeId).toBe(NEWEST.id);
  });

  it('waits for a running turn before applying a navigation', async () => {
    const { result, rerender } = await mount();
    act(() => result.current.setBusy(true));
    rerender({ requested: { conversationId: OLDER.id } });
    await settle();
    expect(result.current.activeId).toBe(NEWEST.id);
    act(() => result.current.setBusy(false));
    await waitFor(() => expect(result.current.activeId).toBe(OLDER.id));
  });
});

describe('useChatConversations — threads beyond the loaded page', () => {
  const PINNED: ChatConversationSummary = {
    id: 'conversation-pinned-old',
    title: 'Pinned incident runbook',
    preview: 'Pinned answer',
    created_at: '2026-01-02T08:00:00Z',
    updated_at: '2026-01-02T08:05:00Z',
    message_count: 2,
    pinned: true,
  };

  beforeEach(() => {
    getMock.mockImplementation((id: string) => {
      const row = [OLDER, NEWEST, PINNED].find((item) => item.id === id);
      return row ? Promise.resolve(detail(row)) : Promise.reject(new ApiError(404, 'conversation not found'));
    });
  });

  it('checks a requested thread missing from the page before calling it unavailable', async () => {
    const { result } = await mount({ requested: { conversationId: PINNED.id, messageId: `${PINNED.id}-user` } });
    await waitFor(() => expect(result.current.activeId).toBe(PINNED.id));
    expect(result.current.requestedUnavailable).toBe(false);
    expect(result.current.conversations.map((c) => c.id)).toEqual([NEWEST.id, OLDER.id, PINNED.id]);
    expect(result.current.conversations.find((c) => c.id === PINNED.id)?.pinned).toBe(true);
    expect(result.current.highlight).toMatchObject({ conversationId: PINNED.id, messageId: `${PINNED.id}-user` });
    await waitFor(() => expect(result.current.conversation?.id).toBe(PINNED.id));
  });

  it('never calls a thread gone when the check itself fails', async () => {
    getMock.mockImplementation((id: string) =>
      id === 'conversation-flaky' ? Promise.reject(new ApiError(503, 'History is unavailable.')) : Promise.resolve(detail(NEWEST)),
    );
    const { result } = await mount({ requested: { conversationId: 'conversation-flaky' } });
    await waitFor(() => expect(result.current.activeId).toBe('conversation-flaky'));
    expect(result.current.requestedUnavailable).toBe(false);
    await waitFor(() => expect(result.current.threadError).toBe('History is unavailable.'));
  });

  it('keeps a selected off-page thread across refreshes, and falls back once it is deleted', async () => {
    const { result } = await mount({ requested: { conversationId: PINNED.id } });
    await waitFor(() => expect(result.current.conversation?.id).toBe(PINNED.id));

    act(() => window.dispatchEvent(new Event('focus')));
    await settle();
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(result.current.activeId).toBe(PINNED.id);
    expect(result.current.conversations.some((c) => c.id === PINNED.id)).toBe(true);

    // Deleted in another tab: the check answers 404 and the newest thread opens.
    getMock.mockImplementation((id: string) => {
      const row = [OLDER, NEWEST].find((item) => item.id === id);
      return row ? Promise.resolve(detail(row)) : Promise.reject(new ApiError(404, 'conversation not found'));
    });
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(result.current.activeId).toBe(NEWEST.id));
    expect(result.current.conversations.map((c) => c.id)).toEqual([NEWEST.id, OLDER.id]);
  });

  it('titles an optimistic row as display text, and keeps a known row title on an empty one', async () => {
    const { result } = await mount();
    act(() => result.current.conversationPersisted('conversation-new', 'Is adm\u200Bin \u202Eok?'));
    expect(result.current.conversations[0]).toMatchObject({ id: 'conversation-new', title: 'Is admin ok?' });
    act(() => result.current.conversationPersisted(OLDER.id, ''));
    expect(result.current.conversations[0]).toMatchObject({ id: OLDER.id, title: OLDER.title });
    await settle();
  });

  it('refuses to delete the thread a turn is running in, before or after the dialog', async () => {
    let release!: (ok: boolean) => void;
    const confirmDelete = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const { result } = await mount({ confirmDelete });
    act(() => result.current.setBusy(true));
    await act(async () => {
      expect(await result.current.remove(NEWEST)).toBe(false);
    });
    expect(confirmDelete).not.toHaveBeenCalled();
    expect(result.current.listError).toMatch(/Wait for the current answer/);

    act(() => result.current.setBusy(false));
    await settle();
    let removed!: Promise<boolean>;
    act(() => {
      removed = result.current.remove(NEWEST);
    });
    act(() => result.current.setBusy(true));
    await act(async () => {
      release(true);
      expect(await removed).toBe(false);
    });
    expect(deleteMock).not.toHaveBeenCalled();
    expect(result.current.activeId).toBe(NEWEST.id);

    // Another thread can still be deleted mid-turn.
    confirmDelete.mockImplementation(() => Promise.resolve(true));
    await act(async () => {
      expect(await result.current.remove(OLDER)).toBe(true);
    });
    expect(deleteMock).toHaveBeenCalledWith(OLDER.id);
  });
});
