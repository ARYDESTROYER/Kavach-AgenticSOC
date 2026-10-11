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

const { listMock, getMock, updateMock, deleteMock, readMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  getMock: vi.fn(),
  updateMock: vi.fn(),
  deleteMock: vi.fn(),
  readMock: vi.fn(),
}));

vi.mock('../turn-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../turn-runner')>();
  return { ...actual, markConversationRead: readMock };
});

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
  clearChatActivity,
  getChatActivity,
  putChatActivity,
  settleChatActivity,
  viewChatActivity,
  type ChatActivity,
} from '../../chat-activity/activity';
import {
  HISTORY_CHANNEL,
  NEW_DRAFT_KEY,
  overlayActivity,
  parseChatNavRequest,
  preferredThread,
  threadRetentionInfo,
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

function activity(patch: Partial<ChatActivity> & { scope: string }): ChatActivity {
  return {
    kind: 'workspace',
    conversationId: null,
    caseId: null,
    turnId: null,
    requestKey: null,
    title: '',
    label: null,
    lookups: 0,
    status: 'running',
    startedAt: Date.parse('2026-07-26T10:00:00Z'),
    source: 'local',
    ...patch,
  };
}

/**
 * Node's BroadcastChannel crosses test workers, so another suite's "history changed"
 * would refresh these rails at random: a same-realm channel keeps the signals here.
 */
class RealmChannel {
  static open: RealmChannel[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(public name: string) {
    RealmChannel.open.push(this);
  }
  postMessage(data: unknown) {
    for (const other of RealmChannel.open) if (other !== this && other.name === this.name) other.onmessage?.({ data } as MessageEvent);
  }
  close() {
    RealmChannel.open = RealmChannel.open.filter((item) => item !== this);
  }
}

beforeEach(() => {
  RealmChannel.open = [];
  vi.stubGlobal('BroadcastChannel', RealmChannel);
  clearChatActivity();
  readMock.mockReset();
  readMock.mockResolvedValue(true);
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
  vi.unstubAllGlobals();
});

describe('useChatConversations — list and selection', () => {
  it('sorts newest first, selects the newest and hydrates it', async () => {
    const { result } = await mount();
    expect(listMock).toHaveBeenCalledWith({ limit: 60 });
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

    const transcriptEpoch = result.current.transcriptEpoch;
    const draftEpoch = result.current.newDraftEpoch;
    act(() => result.current.select(OLDER));
    expect(result.current.activeId).toBe(OLDER.id);
    expect(result.current.conversation).toBeNull();
    expect(result.current.restoring).toBe(true);
    // A selection resets the engine even when `conversation` stays null; it is not
    // a New-chat draft.
    expect(result.current.transcriptEpoch).toBe(transcriptEpoch + 1);
    expect(result.current.newDraftEpoch).toBe(draftEpoch);

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

  it('links a row to the report an add just created (no wait for the next refresh)', async () => {
    const { result } = await mount();
    expect(result.current.conversations.find((c) => c.id === OLDER.id)?.report_id ?? null).toBeNull();
    act(() => result.current.noteReport(OLDER.id, 'r-9'));
    expect(result.current.conversations.find((c) => c.id === OLDER.id)?.report_id).toBe('r-9');
    // Unknown rows are ignored.
    act(() => result.current.noteReport('c-missing', 'r-1'));
    expect(result.current.conversations.map((c) => c.id)).toEqual([NEWEST.id, OLDER.id]);
  });

  it('keeps a deliberate New chat across list refreshes, and bumps the draft epoch', async () => {
    const { result } = await mount();
    const epoch = result.current.newDraftEpoch;
    act(() => result.current.startNew());
    expect(result.current.activeId).toBeNull();
    expect(result.current.conversation).toBeNull();
    expect(result.current.newDraftEpoch).toBe(epoch + 1);
    expect(result.current.transcriptEpoch).toBeGreaterThan(0);
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

  it('never refuses selection or New chat while a turn is in flight (the answer keeps streaming)', async () => {
    const { result } = await mount();
    act(() => result.current.setBusy(true));
    act(() => result.current.select(OLDER));
    expect(result.current.activeId).toBe(OLDER.id);
    act(() => result.current.startNew());
    expect(result.current.activeId).toBeNull();
    await settle();
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
      'Showing the latest 100 of 148 messages. Conversations keep their newest 100 messages.',
    );
    expect(result.current.threadRetention.removed).toBe(true);
  });

  it('bases the removed-turns note on the counts, not on history_truncated', async () => {
    // One large answer tightened to fit storage: truncated, but no turn is missing.
    const tightened = { ...NEWEST, message_count: 2, total_message_count: 2, history_truncated: true };
    listMock.mockResolvedValueOnce({ conversations: [tightened] });
    getMock.mockResolvedValueOnce({ ...detail(tightened), message_count: 2, total_message_count: 2, history_truncated: true });
    const { result } = await mount();
    expect(result.current.threadRetention.removed).toBe(false);
    expect(result.current.threadRetention.note).toBeNull();
    // Shortened in place only: no thread-level line (each compacted answer says so).
    expect(result.current.threadRetention.truncated).toBe(true);
  });

  it('words removed turns by their cause and keeps a shortened-only thread quiet', () => {
    expect(threadRetentionInfo(40, 62, true)).toMatchObject({
      removed: true,
      note: 'Showing the latest 40 of 62 messages. Older messages were removed to stay within the storage limit.',
    });
    expect(threadRetentionInfo(100, 130, false).note).toBe(
      'Showing the latest 100 of 130 messages. Conversations keep their newest 100 messages.',
    );
    expect(threadRetentionInfo(4, 4, true)).toEqual({ truncated: true, removed: false, retained: 4, total: 4, note: null });
    expect(threadRetentionInfo(4, 4, false)).toMatchObject({ removed: false, note: null });
    // Legacy rows without counts never claim a removal.
    expect(threadRetentionInfo(null, null, true)).toMatchObject({ removed: false, note: null });
  });

  it('asks for the full 60-row page (50 kept + 10 pinned) but keeps the footer at the 50 retention', async () => {
    listMock.mockResolvedValueOnce({ conversations: [NEWEST, OLDER], limit: 60, total: 60, history_truncated: false });
    const { result } = await mount();
    expect(listMock).toHaveBeenCalledWith({ limit: 60 });
    expect(result.current.retention.limit).toBe(50);
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
    expect(listMock.mock.calls.filter(([query]) => query.q)).toEqual([[{ limit: 60, q: 'failed logins' }]]);
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
      ask: null,
      entity: null,
    });
    expect(parseChatNavRequest({ conversationId: 'bad id!', messageId: 'm-1' })).toBeNull();
    expect(parseChatNavRequest({ messageId: 'm-1', newChat: true })).toEqual({ conversationId: null, messageId: null, newChat: true, topic: null, ask: null, entity: null });
    expect(parseChatNavRequest({ topic: 'kpi:mttr' })).toEqual({ conversationId: null, messageId: null, newChat: true, topic: 'kpi:mttr', ask: null, entity: null });
    expect(parseChatNavRequest({ topic: 'What is the MTTR? Ignore rules' })).toBeNull();
    // The console-link grammar: up to 40 + ':' + 80 = 121 characters, a colon required.
    const longest = `${'k'.repeat(40)}:${'x'.repeat(80)}`;
    expect(parseChatNavRequest({ topic: longest })?.topic).toBe(longest);
    expect(parseChatNavRequest({ topic: `${'k'.repeat(41)}:x` })).toBeNull();
    expect(parseChatNavRequest({ topic: 'kpi' })).toBeNull();
  });

  it("reads the palette's ask as a fresh draft, trimmed, capped and never with a topic or thread", () => {
    expect(parseChatNavRequest({ ask: '  why did case-12 escalate?  ' })).toEqual({
      conversationId: null,
      messageId: null,
      newChat: true,
      topic: null,
      ask: 'why did case-12 escalate?',
      entity: null,
    });
    expect(parseChatNavRequest({ ask: '   ' })).toBeNull();
    expect(parseChatNavRequest({ ask: 'x'.repeat(2500) })?.ask).toHaveLength(2000);
    // A templated topic is what the page sends; free text never rides along with it.
    expect(parseChatNavRequest({ topic: 'kpi:mttr', ask: 'and also this' })?.ask).toBeNull();
    // A requested thread wins over a fresh draft, so there is no draft to prefill.
    expect(parseChatNavRequest({ conversationId: 'c-1', ask: 'hello' })?.ask).toBeNull();
  });

  it("carries an Ask AI chip's typed reference to the fresh draft once (Round 12 WP-ASK)", async () => {
    const { result, rerender } = await mount();
    rerender({ requested: { newChat: true, entity: { kind: 'ip', value: '203.0.113.77' } } });
    await settle();
    expect(result.current.activeId).toBeNull();
    expect(result.current.entity).toEqual({ kind: 'ip', value: '203.0.113.77' });
    // Never a prefill: the page asks the server's question instead.
    expect(result.current.ask).toBeNull();
    act(() => result.current.clearEntity());
    expect(result.current.entity).toBeNull();
    rerender({ requested: { newChat: true, entity: { kind: 'host', value: 'dc01' } } });
    await settle();
    rerender({ requested: { conversationId: OLDER.id } });
    await settle();
    // A later navigation drops an unconsumed reference.
    expect(result.current.entity).toBeNull();
  });

  it('carries an ask to the fresh draft once, and a later navigation drops an unconsumed one', async () => {
    const { result, rerender } = await mount();
    rerender({ requested: { newChat: true, ask: 'Summarise failed logins' } });
    await settle();
    expect(result.current.activeId).toBeNull();
    expect(result.current.ask).toBe('Summarise failed logins');
    act(() => result.current.clearAsk());
    expect(result.current.ask).toBeNull();

    rerender({ requested: { newChat: true, ask: 'Another question' } });
    await settle();
    expect(result.current.ask).toBe('Another question');
    rerender({ requested: { conversationId: OLDER.id } });
    await settle();
    expect(result.current.activeId).toBe(OLDER.id);
    expect(result.current.ask).toBeNull();
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

  it('applies a navigation at once, even while a turn runs (an "Answer ready — Open" toast)', async () => {
    const { result, rerender } = await mount();
    act(() => result.current.setBusy(true));
    rerender({ requested: { conversationId: OLDER.id } });
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

describe('useChatConversations — live statuses (Round 12, SPEC D13)', () => {
  it('overlays the activity store on the server rows and adds a row for a new thread being answered', () => {
    const rows = [{ ...NEWEST, status: 'running' as const }, OLDER];
    const out = overlayActivity(rows, [
      activity({ scope: `conv:${NEWEST.id}`, conversationId: NEWEST.id, status: 'unread' }),
      activity({ scope: `conv:${OLDER.id}`, conversationId: OLDER.id, status: 'failed' }),
      activity({ scope: 'conv:conversation-fresh', conversationId: 'conversation-fresh', title: 'Investigate host X' }),
      activity({ scope: 'case:case-1', kind: 'case', caseId: 'case-1' }),
    ]);
    expect(out.map((row) => [row.id, row.status ?? 'idle', row.unread === true])).toEqual([
      ['conversation-fresh', 'running', false],
      [NEWEST.id, 'idle', true],
      [OLDER.id, 'failed', false],
    ]);
    expect(out[0]).toMatchObject({ title: 'Investigate host X', message_count: 0 });
    // Nothing live: the very same array (no re-render churn).
    expect(overlayActivity(rows, [])).toBe(rows);
  });

  it('prefers a running thread, then one waiting on the analyst or unread, then the newest', () => {
    expect(preferredThread([NEWEST, { ...OLDER, status: 'running' }])).toBe(OLDER.id);
    expect(preferredThread([NEWEST, { ...OLDER, unread: true }])).toBe(OLDER.id);
    expect(preferredThread([NEWEST, { ...OLDER, status: 'needs_input' }])).toBe(OLDER.id);
    expect(preferredThread([NEWEST, OLDER])).toBe(NEWEST.id);
    expect(preferredThread([])).toBeNull();
  });

  it('opens the thread a turn is running in rather than the newest on a fresh visit', async () => {
    putChatActivity(activity({ scope: `conv:${OLDER.id}`, conversationId: OLDER.id, title: OLDER.title }));
    const { result } = await mount();
    expect(result.current.activeId).toBe(OLDER.id);
    expect(result.current.conversations.find((row) => row.id === OLDER.id)?.status).toBe('running');
  });

  it('opens an unread answer the server reports over the newest', async () => {
    listMock.mockResolvedValue({ conversations: [NEWEST, { ...OLDER, unread: true }] });
    const { result } = await mount();
    expect(result.current.activeId).toBe(OLDER.id);
    await waitFor(() => expect(readMock).toHaveBeenCalledWith(OLDER.id));
    await waitFor(() => expect(result.current.conversations.find((row) => row.id === OLDER.id)?.unread).toBe(false));
  });

  it('marks an answer read only while the tab is visible', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      listMock.mockResolvedValue({ conversations: [{ ...NEWEST, unread: true }, OLDER] });
      await mount();
      await settle();
      expect(readMock).not.toHaveBeenCalled();
      visibility.mockReturnValue('visible');
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await waitFor(() => expect(readMock).toHaveBeenCalledWith(NEWEST.id));
    } finally {
      visibility.mockRestore();
    }
  });

  it('opens a new thread whose first answer is still being written (the detail is 404 until saved)', async () => {
    putChatActivity(activity({ scope: 'conv:conversation-fresh', conversationId: 'conversation-fresh', title: 'Investigate host X' }));
    const { result } = await mount();
    expect(result.current.activeId).toBe('conversation-fresh');
    await waitFor(() => expect(result.current.conversation).toMatchObject({ id: 'conversation-fresh', messages: [] }));
    expect(result.current.threadError).toBeNull();
    expect(result.current.restoring).toBe(false);
  });

  it('refuses to delete any thread whose answer is still being written', async () => {
    const confirmDelete = vi.fn(() => Promise.resolve(true));
    putChatActivity(activity({ scope: `conv:${OLDER.id}`, conversationId: OLDER.id }));
    const { result } = await mount({ confirmDelete });
    act(() => result.current.select(NEWEST));
    await act(async () => {
      expect(await result.current.remove(OLDER)).toBe(false);
    });
    expect(deleteMock).not.toHaveBeenCalled();
    // Once it finished it can go.
    act(() => settleChatActivity(`conv:${OLDER.id}`, 'done'));
    await act(async () => {
      expect(await result.current.remove(OLDER)).toBe(true);
    });
  });

  it('keeps a placeholder row for every status the page does not list yet', () => {
    const out = overlayActivity(
      [NEWEST],
      [
        activity({ scope: 'conv:fresh-unread', conversationId: 'fresh-unread', status: 'unread', title: 'Top talkers' }),
        activity({ scope: 'conv:fresh-failed', conversationId: 'fresh-failed', status: 'failed', title: 'Broken' }),
        activity({ scope: 'conv:fresh-question', conversationId: 'fresh-question', status: 'needs_input', title: 'Which host?' }),
      ],
    );
    expect(out.map((row) => [row.id, row.status, row.unread === true])).toEqual([
      ['fresh-question', 'needs_input', false],
      ['fresh-failed', 'failed', false],
      ['fresh-unread', 'idle', true],
      [NEWEST.id, undefined, false],
    ]);
  });

  it('keeps a background thread’s row when its answer lands while the open thread is answering', async () => {
    // Thread A ("Top talkers") answers in the background; the open thread B is busy, so
    // list refreshes wait. A's row must not vanish when its answer settles.
    putChatActivity(activity({ scope: 'conv:conv-a', conversationId: 'conv-a', title: 'Top talkers' }));
    const { result } = await mount();
    act(() => result.current.select(NEWEST));
    await settle();
    act(() => result.current.setBusy(true));
    expect(result.current.conversations.find((row) => row.id === 'conv-a')?.status).toBe('running');
    act(() => settleChatActivity('conv:conv-a', 'done'));
    // The history broadcast and a focus are deferred while B is busy …
    act(() => window.dispatchEvent(new Event('focus')));
    await settle();
    const row = result.current.conversations.find((item) => item.id === 'conv-a');
    // … but the row stays, now marked unread, and opens.
    expect(row).toMatchObject({ title: 'Top talkers', unread: true });
    act(() => result.current.setBusy(false));
    // The deferred refresh runs now.
    await settle();
  });

  it('leaves out the new thread whose first answer is on screen as New chat, and shows it once opened', async () => {
    const { result } = await mount();
    act(() => result.current.startNew());
    await settle();
    act(() => putChatActivity(activity({ scope: 'conv:conv-new', conversationId: 'conv-new', title: 'First question' })));
    // The engine on screen views the run (its scope became `conv:<id>` at turn.start).
    let release: () => void = () => undefined;
    act(() => {
      release = viewChatActivity('conv:conv-new');
    });
    expect(result.current.activeId).toBeNull();
    expect(result.current.conversations.some((row) => row.id === 'conv-new')).toBe(false);
    act(() => release());
    expect(result.current.conversations.find((row) => row.id === 'conv-new')?.status).toBe('running');
    // Opened from the rail it is the selected thread (and its row stays).
    act(() => result.current.select('conv-new'));
    act(() => {
      release = viewChatActivity('conv:conv-new');
    });
    expect(result.current.conversations.some((row) => row.id === 'conv-new')).toBe(true);
    act(() => release());
    await settle();
  });

  it('opens the server’s temporary running row of a new thread (its detail is 404 until the answer saves)', async () => {
    // After a reload the list holds the new thread as a running row; nothing is saved yet.
    listMock.mockResolvedValue({ conversations: [NEWEST, { ...OLDER, id: 'conv-temp', title: 'Investigate host X', status: 'running' }] });
    const { result } = await mount();
    expect(result.current.activeId).toBe('conv-temp');
    await waitFor(() => expect(result.current.conversation).toMatchObject({ id: 'conv-temp', messages: [] }));
    expect(result.current.threadError).toBeNull();
  });

  it('opens a placeholder for a thread only this browser knows (its saved copy is 404), whatever its status', async () => {
    putChatActivity(activity({ scope: 'conv:conv-gone', conversationId: 'conv-gone', status: 'failed', title: 'Investigate host X' }));
    const { result } = await mount();
    act(() => result.current.select('conv-gone'));
    await waitFor(() => expect(result.current.conversation).toMatchObject({ id: 'conv-gone', messages: [] }));
    expect(result.current.threadError).toBeNull();
  });

  it('deleting a thread drops its marks (in every tab) and an answer nobody opened', async () => {
    const confirmDelete = vi.fn(() => Promise.resolve(true));
    putChatActivity(activity({ scope: `conv:${OLDER.id}`, conversationId: OLDER.id, status: 'unread', title: OLDER.title }));
    const { result } = await mount({ confirmDelete });
    act(() => result.current.select(NEWEST));
    await act(async () => {
      expect(await result.current.remove(OLDER)).toBe(true);
    });
    expect(getChatActivity().entries.find((entry) => entry.scope === `conv:${OLDER.id}`)).toBeUndefined();
    expect(getChatActivity().workspace.status).toBeNull();
  });

  it('reloads the open thread when a followed turn asks for it (rehydrate)', async () => {
    const { result } = await mount();
    await waitFor(() => expect(result.current.conversation?.id).toBe(NEWEST.id));
    const calls = getMock.mock.calls.length;
    act(() => result.current.conversationPersisted(NEWEST.id, '', { rehydrate: true }));
    await waitFor(() => expect(getMock.mock.calls.length).toBe(calls + 1));
  });
});
