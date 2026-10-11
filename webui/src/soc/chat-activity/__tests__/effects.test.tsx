/**
 * ActivityEffects (Round 12, SPEC D13), the shell's lazy chat-turn observer: other tabs
 * agree through a BroadcastChannel (per user); a reload mid-turn hands the running turn
 * to the turn runner (which follows it without a connection and reads its real
 * outcome); the list adds titles, unread answers and waiting questions and drops marks
 * for threads that are gone; a turn that finished off screen toasts once (the toaster's
 * own live region announces it, nothing else repeats it); the tab title carries ● / ✓;
 * owner-only `chat.turn` frames only nudge the runner; sign-out or another user forgets
 * everything, here and in the user's other tabs.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

const { getMock, toastMock, streamState, authState, runnerMock } = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), warning: vi.fn(), error: vi.fn() });
  return {
    getMock: vi.fn(),
    toastMock: toast,
    streamState: { enabled: false, onEvent: null as null | ((event: { type: string; data: unknown; lastEventId: string }) => void) },
    authState: { authEnabled: true, can: true },
    runnerMock: { trackRun: vi.fn(), pollParkedRuns: vi.fn() },
  };
});

vi.mock('@/lib/api', () => ({ api: { get: (...args: unknown[]) => getMock(...args) } }));
vi.mock('sonner', () => ({ toast: toastMock }));
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
// The turn runner is the lazy chat code: here it is a double that records what it is
// asked to follow (its own suite covers parking, polling and outcomes).
vi.mock('@/soc/chat/turn-runner', () => runnerMock);

import { AnnouncerProvider } from '@/soc/components/announcer';
import ActivityEffects, { ACTIVITY_CHANNEL, settledCopy, titlePrefix } from '../ActivityEffects';
import {
  clearChatActivity,
  getChatActivity,
  putChatActivity,
  settleChatActivity,
  takeCaseChatRequest,
  viewChatActivity,
  type ChatActivity,
} from '../activity';

/* A same-realm BroadcastChannel: delivers to every OTHER instance with the name. */
class FakeChannel {
  static all: FakeChannel[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  posted: unknown[] = [];
  received: unknown[] = [];
  constructor(public name: string) {
    FakeChannel.all.push(this);
  }
  postMessage(data: unknown) {
    this.posted.push(data);
    for (const other of FakeChannel.all) {
      if (other !== this && other.name === this.name) {
        other.received.push(data);
        other.onmessage?.({ data } as MessageEvent);
      }
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
let rows: unknown[] | (() => Promise<unknown[]>) = [];

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
    if (path === 'chat/conversations') return { conversations: typeof rows === 'function' ? await rows() : rows };
    throw new Error(`unexpected ${path}`);
  });
  // Like the runner: a followed turn is this tab's own, parked run.
  runnerMock.trackRun.mockReset();
  runnerMock.trackRun.mockImplementation((options: Partial<ChatActivity> & { scope: string; turnId: string }) => {
    putChatActivity(
      entry({
        scope: options.scope,
        kind: options.kind,
        conversationId: options.conversationId ?? null,
        caseId: options.caseId ?? null,
        turnId: options.turnId,
        title: options.title ?? '',
        label: options.label ?? null,
        lookups: options.lookups ?? 0,
        parked: true,
      }),
    );
    return {};
  });
  runnerMock.pollParkedRuns.mockReset();
  toastMock.success.mockReset();
  toastMock.warning.mockReset();
  toastMock.error.mockReset();
  document.title = 'Agentic SOC';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const settle = (ms = 20) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

async function mountEffects(onNavigate = vi.fn(), username = 'alice') {
  const view = render(<ActivityEffects username={username} onNavigate={onNavigate} />);
  await settle();
  return { ...view, onNavigate };
}

describe('pure helpers', () => {
  it('prefixes the title with ● while working and ✓ for an unread answer only', () => {
    expect(titlePrefix([])).toBe('');
    expect(titlePrefix([entry({ scope: 'a', status: 'unread' }), entry({ scope: 'b' })])).toBe('●');
    expect(titlePrefix([entry({ scope: 'a', status: 'unread' })])).toBe('✓');
    // A waiting question is not "done": no check mark (the nav shows it in amber).
    expect(titlePrefix([entry({ scope: 'a', status: 'needs_input' })])).toBe('');
    expect(titlePrefix([entry({ scope: 'a', status: 'needs_input', seen: true })])).toBe('');
    expect(titlePrefix([entry({ scope: 'a', status: 'failed' })])).toBe('');
  });

  it('toasts only for a turn that finished off screen, naming a case chat’s case', () => {
    const activity = entry({ scope: 'conv:c', title: 'Investigate host X' });
    expect(settledCopy({ activity, outcome: 'done', viewed: true })).toBeNull();
    expect(settledCopy({ activity, outcome: 'stopped', viewed: false })).toBeNull();
    expect(settledCopy({ activity, outcome: 'done', viewed: false })).toEqual({
      heading: 'Answer ready',
      title: 'Investigate host X',
      action: 'Open',
    });
    expect(settledCopy({ activity: entry({ scope: 'case:c', kind: 'case', caseId: 'case-3', title: 'Summarize case' }), outcome: 'error', viewed: false })).toEqual({
      heading: 'The answer could not be completed',
      title: 'Case case-3: Summarize case',
      action: 'Open',
    });
    // A new thread that saved nothing: nothing to open, ask again instead.
    expect(settledCopy({ activity, outcome: 'error', viewed: false, unreachable: true, prompt: 'Investigate host X' })).toEqual({
      heading: 'The answer could not be completed',
      title: 'Investigate host X',
      action: 'Ask again',
    });
    expect(settledCopy({ activity, outcome: 'done', viewed: false, unreachable: true })?.heading).toBe('The answer could not be saved');
  });
});

describe('ActivityEffects', () => {
  it('hands a turn that still runs after a reload to the runner, titled from the list', async () => {
    active = [{ turn_id: 'turn-1', conversation_id: 'c1', case_id: null, started_at: '2026-10-10T10:00:00Z', label: 'Searching logs', lookups: 2, tokens: 900, status: 'running' }];
    rows = [{ id: 'c1', title: 'Investigate host X', status: 'running', unread: false }];
    await mountEffects();
    await waitFor(() => expect(find('conv:c1')).toMatchObject({ source: 'local', parked: true, turnId: 'turn-1', title: 'Investigate host X' }));
    expect(runnerMock.trackRun).toHaveBeenCalledTimes(1);
    expect(runnerMock.trackRun).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'conv:c1', kind: 'workspace', turnId: 'turn-1', conversationId: 'c1', label: 'Searching logs', lookups: 2 }),
    );
    expect(document.title).toBe('● Agentic SOC');
    // Owner-only frames only while a parked turn runs (auth on, tab visible): progress
    // updates the label; an end asks the runner to look now (it reads the outcome).
    expect(streamState.enabled).toBe(true);
    act(() => streamState.onEvent?.({ type: 'chat.turn', data: { turn_id: 'turn-1', conversation_id: 'c1', phase: 'progress', label: 'Writing the answer', lookups: 3 }, lastEventId: '' }));
    expect(find('conv:c1')).toMatchObject({ label: 'Writing the answer', lookups: 3 });
    await act(async () => {
      streamState.onEvent?.({ type: 'chat.turn', data: { turn_id: 'turn-1', conversation_id: 'c1', phase: 'failed' }, lastEventId: '' });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(runnerMock.pollParkedRuns).toHaveBeenCalledTimes(1);
    // It never settles a turn itself (it cannot know the outcome): no toast, no mark.
    expect(find('conv:c1')?.status).toBe('running');
    expect(toastMock.success).not.toHaveBeenCalled();
    // A turn this tab already follows is never handed over twice.
    await act(async () => {
      streamState.onEvent?.({ type: 'chat.turn', data: { turn_id: 'turn-9', conversation_id: 'c9', phase: 'started' }, lastEventId: '' });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(runnerMock.trackRun).toHaveBeenCalledTimes(1);
  });

  it('follows a case turn the same way, and a failed frame never reads as an answer', async () => {
    active = [{ turn_id: 'turn-c', conversation_id: null, case_id: 'case-7', started_at: '2026-10-11T10:00:00Z', label: 'Thinking', lookups: 0, status: 'running' }];
    await mountEffects();
    await waitFor(() => expect(find('case:case-7')).toMatchObject({ kind: 'case', caseId: 'case-7', parked: true }));
    active = [];
    await act(async () => {
      streamState.onEvent?.({ type: 'chat.turn', data: { turn_id: 'turn-c', case_id: 'case-7', phase: 'failed' }, lastEventId: '' });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(runnerMock.pollParkedRuns).toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(find('case:case-7')?.status).not.toBe('unread');
  });

  it('opens no frame stream without auth, and none while the tab is hidden', async () => {
    authState.authEnabled = false;
    active = [{ turn_id: 'turn-2', conversation_id: 'c2', started_at: '2026-10-10T10:00:00Z', label: 'Thinking', lookups: 0, status: 'running' }];
    const first = await mountEffects();
    await waitFor(() => expect(find('conv:c2')?.parked).toBe(true));
    expect(streamState.enabled).toBe(false);
    first.unmount();
    await settle(5);
    authState.authEnabled = true;
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await mountEffects();
    await waitFor(() => expect(find('conv:c2')?.parked).toBe(true));
    expect(streamState.enabled).toBe(false);
    hidden.mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(streamState.enabled).toBe(true);
    hidden.mockRestore();
  });

  it('shows unread answers and waiting questions from the list on load, never failed ones', async () => {
    rows = [
      { id: 'u', title: 'Unread', unread: true },
      { id: 'q', title: 'Waiting', status: 'needs_input', unread: true },
      { id: 'r', title: 'Opened already', status: 'needs_input', unread: false },
      { id: 'f', title: 'Failed', status: 'failed' },
      { id: 'i', title: 'Idle' },
    ];
    await mountEffects();
    await waitFor(() => expect(find('conv:u')?.status).toBe('unread'));
    expect(find('conv:q')).toMatchObject({ status: 'needs_input', seen: false });
    // A question the analyst already opened (read) stays, but is not news again.
    expect(find('conv:r')).toMatchObject({ status: 'needs_input', seen: true });
    expect(find('conv:f')).toBeNull();
    expect(find('conv:i')).toBeNull();
    // Nothing settled here: no toast for old news.
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('a reload never re-announces a question that was already opened', async () => {
    rows = [{ id: 'c1', title: 'Which host?', status: 'needs_input', unread: false, updated_at: '2026-10-11T09:00:00Z' }];
    await mountEffects();
    await waitFor(() => expect(find('conv:c1')?.seen).toBe(true));
    expect(document.title).toBe('Agentic SOC');
    expect(getChatActivity().workspace.text).toBe('Chat: 1 question waiting for your answer: Which host?');
  });

  it('drops marks for threads the list no longer has, and questions answered elsewhere', async () => {
    let release!: (value: unknown[]) => void;
    rows = () => new Promise<unknown[]>((resolve) => (release = resolve));
    putChatActivity(entry({ scope: 'conv:gone', conversationId: 'gone', status: 'failed', title: 'Deleted thread' }));
    putChatActivity(entry({ scope: 'conv:q', conversationId: 'q', status: 'needs_input', title: 'Answered elsewhere' }));
    putChatActivity(entry({ scope: 'conv:kept', conversationId: 'kept', status: 'unread', title: 'Still here' }));
    putChatActivity(entry({ scope: 'conv:live', conversationId: 'live', title: 'Running' }));
    await mountEffects();
    // An answer that lands while the list loads is newer than the list: it stays.
    act(() => putChatActivity(entry({ scope: 'conv:fresh', conversationId: 'fresh', status: 'unread', title: 'Just now' })));
    await act(async () => {
      release([
        { id: 'q', title: 'Answered elsewhere', status: 'idle' },
        { id: 'kept', title: 'Still here', unread: true },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(find('conv:gone')).toBeNull();
    expect(find('conv:q')).toBeNull();
    expect(find('conv:kept')?.status).toBe('unread');
    expect(find('conv:live')?.status).toBe('running');
    expect(find('conv:fresh')?.status).toBe('unread');
  });

  it('toasts once with Open for an answer that finished off screen, and opens it', async () => {
    const { onNavigate } = await mountEffects();
    act(() => putChatActivity(entry({ scope: 'conv:c9', conversationId: 'c9', turnId: 't9', title: 'Brute force review' })));
    act(() => settleChatActivity('conv:c9', 'done'));
    act(() => settleChatActivity('conv:c9', 'done'));
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    const [heading, options] = toastMock.success.mock.calls[0] as [string, { description: string; action: { label: string; onClick: () => void } }];
    expect(heading).toBe('Answer ready');
    expect(options.description).toBe('Brute force review');
    expect(options.action.label).toBe('Open');
    options.action.onClick();
    expect(onNavigate).toHaveBeenCalledWith('chat', { conversationId: 'c9' });
    // A case answer opens its case on the Chat tab (the case page takes the request).
    act(() => putChatActivity(entry({ scope: 'case:k1', kind: 'case', caseId: 'k1', turnId: 'tk', title: 'Summarize case' })));
    act(() => settleChatActivity('case:k1', 'error'));
    const [, caseOptions] = toastMock.error.mock.calls[0] as [string, { description: string; action: { onClick: () => void } }];
    expect(caseOptions.description).toBe('Case k1: Summarize case');
    caseOptions.action.onClick();
    expect(onNavigate).toHaveBeenCalledWith('case_manager', { caseId: 'k1', tab: 'chat' });
    expect(takeCaseChatRequest('k2')).toBe(false);
    expect(takeCaseChatRequest('k1')).toBe(true);
    expect(takeCaseChatRequest('k1')).toBe(false);
  });

  it('speaks through the toast only: no second live-region message per finished turn', async () => {
    // Mounted under the app's real announcer, as in the shell: only the (mocked) toast
    // may announce, so the page's own live regions must stay silent.
    render(
      <AnnouncerProvider>
        <ActivityEffects username="alice" onNavigate={vi.fn()} />
      </AnnouncerProvider>,
    );
    await settle();
    const announcements: string[] = [];
    // The toaster's region is the one voice; nothing else in the page announces.
    const observer = new MutationObserver(() => {
      for (const region of Array.from(document.querySelectorAll('[aria-live]'))) {
        if (region.textContent) announcements.push(region.textContent);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    act(() => putChatActivity(entry({ scope: 'conv:a', conversationId: 'a', turnId: 'ta', title: 'Weekly hunt' })));
    act(() => settleChatActivity('conv:a', 'done'));
    // The announcer writes its text one tick (60 ms) after clearing it.
    await settle(150);
    observer.disconnect();
    expect(announcements).toEqual([]);
    expect(toastMock.success).toHaveBeenCalledTimes(1);
  });

  it('offers to ask again when a new thread saved nothing (there is nothing to open)', async () => {
    const { onNavigate } = await mountEffects();
    act(() => putChatActivity(entry({ scope: 'conv:tmp', conversationId: 'tmp', turnId: 'tn', title: 'Investigate host X' })));
    act(() => settleChatActivity('conv:tmp', 'error', true, { unreachable: true, prompt: 'Investigate host X over the last quarter' }));
    expect(find('conv:tmp')).toBeNull();
    expect(getChatActivity().workspace.status).toBeNull();
    const [heading, options] = toastMock.error.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
    expect(heading).toBe('The answer could not be completed');
    expect(options.action.label).toBe('Ask again');
    options.action.onClick();
    expect(onNavigate).toHaveBeenCalledWith('chat', { newChat: true, ask: 'Investigate host X over the last quarter' });
  });

  it('stays quiet for an answer the analyst is looking at', async () => {
    await mountEffects();
    act(() => putChatActivity(entry({ scope: 'conv:v', conversationId: 'v', turnId: 'tv' })));
    const release = viewChatActivity('conv:v');
    act(() => settleChatActivity('conv:v', 'done'));
    release();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('agrees with other tabs of the same user only, and follows a closing tab’s turns', async () => {
    await mountEffects();
    const other = new FakeChannel(ACTIVITY_CHANNEL);
    // This tab said hello on mount, and its own changes go out.
    act(() => putChatActivity(entry({ scope: 'conv:mine', conversationId: 'mine', title: 'Mine' })));
    const mine = FakeChannel.all[0];
    expect(mine.posted).toEqual(expect.arrayContaining([{ u: 'alice', hello: true }]));
    expect(mine.posted).toContainEqual({ u: 'alice', m: { t: 'put', a: expect.objectContaining({ scope: 'conv:mine' }) } });
    // Another tab's turn shows here as a peer; another user's never does.
    act(() => other.postMessage({ u: 'alice', m: { t: 'put', a: entry({ scope: 'conv:theirs', conversationId: 'theirs', turnId: 'tt', title: 'Theirs' }) } }));
    act(() => other.postMessage({ u: 'mallory', m: { t: 'put', a: entry({ scope: 'conv:spy', title: 'Spy' }) } }));
    expect(find('conv:theirs')?.source).toBe('peer');
    expect(find('conv:spy')).toBeNull();
    // A new tab asks; this one answers with its own turns.
    mine.posted = [];
    act(() => other.postMessage({ u: 'alice', hello: true }));
    expect(mine.posted).toEqual([{ u: 'alice', m: { t: 'put', a: expect.objectContaining({ scope: 'conv:mine' }) } }]);
    // The other tab closed mid-turn: this tab follows its turn now.
    await act(async () => {
      other.postMessage({ u: 'alice', release: ['conv:theirs'] });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(runnerMock.trackRun).toHaveBeenCalledWith(expect.objectContaining({ scope: 'conv:theirs', turnId: 'tt', title: 'Theirs' }));
    expect(find('conv:theirs')).toMatchObject({ source: 'local', parked: true });
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

  it('tells the user’s other tabs to forget on sign-out, and on another user', async () => {
    const view = render(<ActivityEffects username="alice" onNavigate={vi.fn()} />);
    await settle();
    const otherTab = new FakeChannel(ACTIVITY_CHANNEL);
    act(() => putChatActivity(entry({ scope: 'conv:a', title: 'Secret question' })));
    view.unmount(); // sign-out: the shell goes away
    await settle();
    expect(otherTab.received).toContainEqual({ u: 'alice', m: { t: 'clear' } });
    otherTab.close();

    // Another user in the same shell: alice's other tabs forget too.
    const second = render(<ActivityEffects username="alice" onNavigate={vi.fn()} />);
    await settle();
    const aliceTab = new FakeChannel(ACTIVITY_CHANNEL);
    second.rerender(<ActivityEffects username="bob" onNavigate={vi.fn()} />);
    await settle();
    expect(aliceTab.received).toContainEqual({ u: 'alice', m: { t: 'clear' } });
    expect(aliceTab.received).not.toContainEqual({ u: 'bob', m: { t: 'clear' } });
    aliceTab.close();
    second.unmount();
    await settle();
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
    // Nor does it tell the other tabs to forget.
    expect(FakeChannel.all.flatMap((channel) => channel.posted)).not.toContainEqual(expect.objectContaining({ m: { t: 'clear' } }));
    view.unmount();
  });
});
