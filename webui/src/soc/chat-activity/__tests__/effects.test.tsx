/**
 * ActivityEffects (Round 12, SPEC D13), the shell's lazy chat-turn observer: other tabs agree through a
 * BroadcastChannel (per user), a reload mid-turn recovers from `GET /chat/turns/active`,
 * a turn that finished off screen announces once and toasts once with Open, the tab
 * title carries ● / ✓, owner-only `chat.turn` frames or a poll keep it current, and
 * sign-out or another user forgets everything.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

const { getMock, toastMock, announceMock, streamState, authState } = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), warning: vi.fn(), error: vi.fn() });
  return {
    getMock: vi.fn(),
    toastMock: toast,
    announceMock: vi.fn(),
    streamState: { enabled: false, onEvent: null as null | ((event: { type: string; data: unknown; lastEventId: string }) => void) },
    authState: { authEnabled: true, can: true },
  };
});

vi.mock('@/lib/api', () => ({ api: { get: (...args: unknown[]) => getMock(...args) } }));
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => announceMock }));
vi.mock('@/soc/auth', () => ({
  useOptionalAuth: () => ({ authEnabled: authState.authEnabled, hasPermission: () => authState.can }),
}));
vi.mock('@/lib/useEventStream', () => ({
  useEventStream: (_topics: string[], options: { enabled?: boolean; onEvent?: typeof streamState.onEvent }) => {
    streamState.enabled = !!options.enabled;
    streamState.onEvent = options.onEvent ?? null;
    return { live: false };
  },
}));

import ActivityEffects, { ACTIVITY_CHANNEL, settledCopy, titlePrefix } from '../ActivityEffects';
import {
  clearChatActivity,
  getChatActivity,
  putChatActivity,
  settleChatActivity,
  viewChatActivity,
  type ChatActivity,
} from '../activity';

/* A same-realm BroadcastChannel: delivers to every OTHER instance with the name. */
class FakeChannel {
  static all: FakeChannel[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  posted: unknown[] = [];
  constructor(public name: string) {
    FakeChannel.all.push(this);
  }
  postMessage(data: unknown) {
    this.posted.push(data);
    for (const other of FakeChannel.all) {
      if (other !== this && other.name === this.name) other.onmessage?.({ data } as MessageEvent);
    }
  }
  close() {
    FakeChannel.all = FakeChannel.all.filter((item) => item !== this);
  }
}

function entry(patch: Partial<ChatActivity> & { scope: string }): ChatActivity {
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
    startedAt: 1,
    source: 'local',
    ...patch,
  };
}

const find = (scope: string) => getChatActivity().entries.find((item) => item.scope === scope) ?? null;

let active: unknown[] = [];
let rows: unknown[] = [];

beforeEach(() => {
  clearChatActivity();
  FakeChannel.all = [];
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  active = [];
  rows = [];
  authState.authEnabled = true;
  authState.can = true;
  getMock.mockReset();
  getMock.mockImplementation(async (path: string) => {
    if (path === 'chat/turns/active') return active;
    if (path === 'chat/conversations') return { conversations: rows };
    throw new Error(`unexpected ${path}`);
  });
  toastMock.success.mockReset();
  toastMock.warning.mockReset();
  toastMock.error.mockReset();
  announceMock.mockReset();
  document.title = 'Agentic SOC';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mountEffects(onNavigate = vi.fn(), username = 'alice') {
  const view = render(<ActivityEffects username={username} onNavigate={onNavigate} />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return { ...view, onNavigate };
}

describe('pure helpers', () => {
  it('prefixes the title with ● while working and ✓ for news', () => {
    expect(titlePrefix([])).toBe('');
    expect(titlePrefix([entry({ scope: 'a', status: 'unread' }), entry({ scope: 'b' })])).toBe('●');
    expect(titlePrefix([entry({ scope: 'a', status: 'unread' })])).toBe('✓');
    expect(titlePrefix([entry({ scope: 'a', status: 'needs_input', seen: true })])).toBe('');
    expect(titlePrefix([entry({ scope: 'a', status: 'failed' })])).toBe('');
  });

  it('speaks and toasts only for a turn that finished off screen', () => {
    const activity = entry({ scope: 'conv:c', title: 'Investigate host X' });
    expect(settledCopy({ activity, outcome: 'done', viewed: true })).toBeNull();
    expect(settledCopy({ activity, outcome: 'stopped', viewed: false })).toBeNull();
    expect(settledCopy({ activity, outcome: 'done', viewed: false })).toEqual({
      heading: 'Answer ready',
      spoken: 'Answer ready: Investigate host X',
      title: 'Investigate host X',
    });
    expect(settledCopy({ activity: entry({ scope: 'case:c', kind: 'case', caseId: 'case-3' }), outcome: 'error', viewed: false })?.spoken).toBe(
      'Error: Case case-3',
    );
  });
});

describe('ActivityEffects', () => {
  it('recovers a turn that still runs after a reload, titled from the list, and follows it', async () => {
    active = [{ turn_id: 'turn-1', conversation_id: 'c1', case_id: null, started_at: '2026-10-10T10:00:00Z', label: 'Searching logs', lookups: 2, tokens: 900, status: 'running' }];
    rows = [{ id: 'c1', title: 'Investigate host X', status: 'running', unread: false }];
    await mountEffects();
    await waitFor(() => expect(find('conv:c1')).toMatchObject({ source: 'server', turnId: 'turn-1', title: 'Investigate host X', label: 'Searching logs', lookups: 2 }));
    expect(document.title).toBe('● Agentic SOC');
    // Owner-only frames are listened to while a server-tracked turn runs (auth on).
    expect(streamState.enabled).toBe(true);
    act(() => streamState.onEvent?.({ type: 'chat.turn', data: { turn_id: 'turn-1', conversation_id: 'c1', phase: 'progress', label: 'Writing the answer', lookups: 3 }, lastEventId: '' }));
    expect(find('conv:c1')).toMatchObject({ label: 'Writing the answer', lookups: 3 });
    // It finished: the next look sees it gone and the list says the answer is unread.
    active = [];
    rows = [{ id: 'c1', title: 'Investigate host X', status: 'idle', unread: true }];
    await act(async () => {
      streamState.onEvent?.({ type: 'chat.turn', data: { turn_id: 'turn-1', conversation_id: 'c1', phase: 'finished' }, lastEventId: '' });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(find('conv:c1')?.status).toBe('unread');
    expect(announceMock).toHaveBeenCalledWith('Answer ready: Investigate host X', 'polite');
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(document.title).toBe('✓ Agentic SOC');
    expect(streamState.enabled).toBe(false);
  });

  it('polls every 5 seconds when frames cannot arrive (auth off)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    authState.authEnabled = false;
    active = [{ turn_id: 'turn-2', conversation_id: 'c2', started_at: '2026-10-10T10:00:00Z', label: 'Thinking', lookups: 0, status: 'running' }];
    rows = [{ id: 'c2', title: 'Weekly hunt' }];
    await mountEffects();
    await waitFor(() => expect(find('conv:c2')?.status).toBe('running'));
    expect(streamState.enabled).toBe(false);
    const before = getMock.mock.calls.filter(([path]) => path === 'chat/turns/active').length;
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(getMock.mock.calls.filter(([path]) => path === 'chat/turns/active').length).toBe(before + 1);
  });

  it('shows unread answers and waiting questions from the list on load, never failed ones', async () => {
    rows = [
      { id: 'u', title: 'Unread', unread: true },
      { id: 'q', title: 'Waiting', status: 'needs_input' },
      { id: 'f', title: 'Failed', status: 'failed' },
      { id: 'i', title: 'Idle' },
    ];
    await mountEffects();
    await waitFor(() => expect(find('conv:u')?.status).toBe('unread'));
    expect(find('conv:q')?.status).toBe('needs_input');
    expect(find('conv:f')).toBeNull();
    expect(find('conv:i')).toBeNull();
    // Nothing settled here: no toast for old news.
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('toasts once with Open for an answer that finished off screen, and opens it', async () => {
    const { onNavigate } = await mountEffects();
    act(() => putChatActivity(entry({ scope: 'conv:c9', conversationId: 'c9', turnId: 't9', title: 'Brute force review' })));
    act(() => settleChatActivity('conv:c9', 'done'));
    act(() => settleChatActivity('conv:c9', 'done'));
    expect(announceMock).toHaveBeenCalledTimes(1);
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    const [heading, options] = toastMock.success.mock.calls[0] as [string, { description: string; action: { label: string; onClick: () => void } }];
    expect(heading).toBe('Answer ready');
    expect(options.description).toBe('Brute force review');
    expect(options.action.label).toBe('Open');
    options.action.onClick();
    expect(onNavigate).toHaveBeenCalledWith('chat', { conversationId: 'c9' });
    // A case answer opens its case on the Chat tab.
    act(() => putChatActivity(entry({ scope: 'case:k1', kind: 'case', caseId: 'k1', turnId: 'tk' })));
    act(() => settleChatActivity('case:k1', 'error'));
    const [, caseOptions] = toastMock.error.mock.calls[0] as [string, { action: { onClick: () => void } }];
    caseOptions.action.onClick();
    expect(onNavigate).toHaveBeenCalledWith('case_manager', { caseId: 'k1', tab: 'chat' });
  });

  it('stays quiet for an answer the analyst is looking at', async () => {
    await mountEffects();
    act(() => putChatActivity(entry({ scope: 'conv:v', conversationId: 'v', turnId: 'tv' })));
    const release = viewChatActivity('conv:v');
    act(() => settleChatActivity('conv:v', 'done'));
    release();
    expect(announceMock).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('agrees with other tabs of the same user only', async () => {
    await mountEffects();
    const other = new FakeChannel(ACTIVITY_CHANNEL);
    // This tab said hello on mount, and its own changes go out.
    act(() => putChatActivity(entry({ scope: 'conv:mine', conversationId: 'mine', title: 'Mine' })));
    const mine = FakeChannel.all[0];
    expect(mine.posted).toEqual(expect.arrayContaining([{ u: 'alice', hello: true }]));
    expect(mine.posted).toContainEqual({ u: 'alice', m: { t: 'put', a: expect.objectContaining({ scope: 'conv:mine' }) } });
    // Another tab's turn shows here as a peer; another user's never does.
    act(() => other.postMessage({ u: 'alice', m: { t: 'put', a: entry({ scope: 'conv:theirs', conversationId: 'theirs', title: 'Theirs' }) } }));
    act(() => other.postMessage({ u: 'mallory', m: { t: 'put', a: entry({ scope: 'conv:spy', title: 'Spy' }) } }));
    expect(find('conv:theirs')?.source).toBe('peer');
    expect(find('conv:spy')).toBeNull();
    // A new tab asks; this one answers with its own turns.
    mine.posted = [];
    act(() => other.postMessage({ u: 'alice', hello: true }));
    expect(mine.posted).toEqual([{ u: 'alice', m: { t: 'put', a: expect.objectContaining({ scope: 'conv:mine' }) } }]);
    // The other tab closed mid-turn: its turn is the server's to report now.
    act(() => other.postMessage({ u: 'alice', release: ['conv:theirs'] }));
    expect(find('conv:theirs')?.source).toBe('server');
    other.close();
  });
});

describe('ActivityEffects lifetime', () => {
  it('forgets every turn on sign-out and on another user', async () => {
    const view = render(<ActivityEffects username="alice" onNavigate={vi.fn()} />);
    act(() => putChatActivity(entry({ scope: 'conv:a' })));
    view.rerender(<ActivityEffects username="bob" onNavigate={vi.fn()} />);
    expect(getChatActivity().entries).toEqual([]);
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('chat/turns/active'));
    act(() => putChatActivity(entry({ scope: 'conv:b' })));
    view.unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(getChatActivity().entries).toEqual([]);
  });

  it('survives a development double mount without clearing', async () => {
    const view = render(
      <React.StrictMode>
        <ActivityEffects username="alice" onNavigate={vi.fn()} />
      </React.StrictMode>,
    );
    act(() => putChatActivity(entry({ scope: 'conv:a' })));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(find('conv:a')).not.toBeNull();
    view.unmount();
  });
});
