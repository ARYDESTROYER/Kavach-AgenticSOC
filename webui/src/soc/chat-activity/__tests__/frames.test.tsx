/**
 * Live chat turn frames (Round 12, SPEC D13 / §3.2). The backend publishes owner-only
 * `chat.turn` frames on topic `chat`; the shell's job stream (`JobMonitor`) carries that
 * topic and relays every frame to the lazy `ActivityEffects` through the entry-safe
 * store, so no connection is opened for them. A frame is a nudge, never the truth:
 *  - a turn this tab does not know (another device or browser) is looked up in
 *    `turns/active` and followed by the runner, so the nav glyph, the tab title and the
 *    history rail (which overlays the store) show it without a reload;
 *  - a question this browser sent that is not named yet is never mistaken for one;
 *  - a parked run takes a frame's step label (cleaned, #9) and wakes when its turn ends;
 *  - a turn that ended before it could be followed sends the list to be read for its
 *    mark, announced like a followed turn's (an answer on screen is not news);
 *  - an answer read on another console (`chat.read`) is no news here, and neither is a
 *    mark for it that was already on its way, until a new turn's frame arrives there;
 *  - a turn's outcome shown on another console (a case chat answer, a failure, any
 *    answer: `chat.read` naming the turn) leaves no mark or toast here, and a turn shown
 *    here tells the other consoles (`POST …/turns/{id}/seen`, once);
 *  - a turn this tab only follows waits a short grace before it marks or announces
 *    anything, so the asking console's "seen" lands first (no flash of "Answer ready");
 *  - polling stays the fallback: on load, on becoming visible, after an `overflow`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

type Emit = (event: { type: string; data: unknown; lastEventId: string }) => void;

const { getMock, postMock, listMock, toastMock, streamMock, authState, runnerMock } = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() });
  return {
    getMock: vi.fn(),
    postMock: vi.fn(),
    listMock: vi.fn(),
    toastMock: toast,
    streamMock: vi.fn((_topics: string[], _opts?: { enabled?: boolean; onEvent?: Emit }) => ({ live: true })),
    authState: { authEnabled: true, can: true },
    runnerMock: { trackRun: vi.fn(), pollParkedRuns: vi.fn(), wakeParkedRun: vi.fn() },
  };
});

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: (...args: unknown[]) => getMock(...args),
      post: (...args: unknown[]) => postMock(...args),
      jobs: { ...actual.api.jobs, list: listMock },
    },
  };
});
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('@/soc/auth', () => ({
  useOptionalAuth: () => ({ authEnabled: authState.authEnabled, hasPermission: () => authState.can }),
}));
vi.mock('@/lib/useEventStream', () => ({ useEventStream: streamMock }));
// The turn runner is the lazy chat code: a double that records what it is asked to do
// (its own suite covers following, parking, waking and outcomes).
vi.mock('@/soc/chat/turn-runner', () => runnerMock);

import { JobMonitor } from '@/soc/jobs/JobMonitor';
import ActivityEffects, { FRAME_TIMING, chatReadFrame, chatTurnFrame } from '../ActivityEffects';
import {
  clearChatActivity,
  dropChatActivity,
  getChatActivity,
  isChatActivitySettling,
  patchChatActivity,
  putChatActivity,
  relayChatFrame,
  rekeyChatActivity,
  settleChatActivity,
  showChatTurns,
  viewChatActivity,
  type ChatActivity,
} from '../activity';

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
const frame = (turnId: string, phase: string, extra: Record<string, unknown> = {}) => ({
  turn_id: turnId,
  conversation_id: null,
  case_id: null,
  phase,
  label: '',
  lookups: 0,
  tokens: 0,
  ...extra,
});

let active: unknown[] = [];
let rows: unknown[] = [];
const calls = (path: string) => getMock.mock.calls.filter((call) => call[0] === path).length;
const settle = (ms = 30) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
const DEFAULT_TIMING = { ...FRAME_TIMING };

beforeEach(() => {
  clearChatActivity();
  vi.stubGlobal('BroadcastChannel', undefined);
  active = [];
  rows = [];
  authState.authEnabled = true;
  authState.can = true;
  FRAME_TIMING.settleMs = 5;
  streamMock.mockClear();
  for (const fn of [toastMock, toastMock.success, toastMock.warning, toastMock.error, toastMock.info, toastMock.dismiss]) fn.mockClear();
  listMock.mockReset().mockResolvedValue({ jobs: [], total: 0, limit: 100, offset: 0 });
  postMock.mockReset().mockResolvedValue(undefined);
  getMock.mockReset();
  getMock.mockImplementation(async (path: string) => {
    if (path === 'chat/turns/active') return active;
    if (path === 'chat/conversations') return { conversations: rows };
    if (path === 'auth/me') throw new Error('offline');
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
  runnerMock.wakeParkedRun.mockReset();
  document.title = 'Agentic SOC';
});

afterEach(() => {
  Object.assign(FRAME_TIMING, DEFAULT_TIMING);
  vi.unstubAllGlobals();
});

/** The shell as it runs: the job observer (owner of the stream) and the chat observer. */
async function mountShell() {
  const view = render(
    <>
      <JobMonitor actor="alice" onNavigate={vi.fn()} />
      <ActivityEffects username="alice" onNavigate={vi.fn()} />
    </>,
  );
  await settle();
  return view;
}

/** One frame on the shell's stream, as the browser delivers it. */
function emit(type: string, data: unknown) {
  const call = streamMock.mock.calls[streamMock.mock.calls.length - 1];
  const onEvent = call?.[1]?.onEvent;
  if (!onEvent) throw new Error('no stream subscribed');
  act(() => onEvent({ type, data, lastEventId: '1' }));
}

describe('chatTurnFrame', () => {
  it('reads ids by grammar and cleans the label; anything else is not a frame (#9)', () => {
    expect(chatTurnFrame(frame('turn-1', 'progress', { label: 'Search‮ing\u{E0041} logs', lookups: 2.7 }))).toEqual({
      turnId: 'turn-1',
      conversationId: null,
      phase: 'progress',
      label: 'Searching logs',
      lookups: 2,
    });
    expect(chatTurnFrame(frame('turn-1', 'needs_input'))?.phase).toBe('needs_input');
    expect(chatTurnFrame(frame('../turn', 'started'))).toBeNull();
    expect(chatTurnFrame(frame('turn 1', 'started'))).toBeNull();
    expect(chatTurnFrame(frame('t'.repeat(129), 'started'))).toBeNull();
    expect(chatTurnFrame(frame('turn-1', 'deleted'))).toBeNull();
    expect(chatTurnFrame(frame('turn-1', 'progress', { lookups: -3 }))?.lookups).toBe(0);
    expect(chatTurnFrame('turn-1')).toBeNull();
    expect(chatTurnFrame(null)).toBeNull();
    expect(chatTurnFrame(frame('turn-1', 'started', { conversation_id: 'chat-7' }))?.conversationId).toBe('chat-7');
    expect(chatTurnFrame(frame('turn-1', 'started', { conversation_id: '../chat' }))?.conversationId).toBeNull();
  });
});

describe('chatReadFrame', () => {
  it('reads the ids by grammar; anything else is not a frame (#9)', () => {
    expect(chatReadFrame({ conversation_id: 'chat-1' })).toEqual({ turnId: null, conversationId: 'chat-1', caseId: null });
    expect(chatReadFrame({ turn_id: 'turn-1', case_id: 'case-4' })).toEqual({ turnId: 'turn-1', conversationId: null, caseId: 'case-4' });
    expect(chatReadFrame({ turn_id: 'turn-2', conversation_id: 'chat-2', case_id: null })).toEqual({
      turnId: 'turn-2',
      conversationId: 'chat-2',
      caseId: null,
    });
    // A malformed id is dropped; a frame that names nothing is no frame.
    expect(chatReadFrame({ turn_id: '../turn', case_id: 'case 4' })).toBeNull();
    expect(chatReadFrame({ turn_id: 'turn-3', case_id: '<b>x</b>' })).toEqual({ turnId: 'turn-3', conversationId: null, caseId: null });
    expect(chatReadFrame({ conversation_id: 'chat 1' })).toBeNull();
    expect(chatReadFrame({ conversation_id: '../chat' })).toBeNull();
    expect(chatReadFrame({ conversation_id: 'c'.repeat(129) })).toBeNull();
    expect(chatReadFrame({ conversation_id: 7 })).toBeNull();
    expect(chatReadFrame('chat-1')).toBeNull();
    expect(chatReadFrame(null)).toBeNull();
  });
});

describe('live chat turn frames', () => {
  it('ride the job observer’s one stream: the chat observer opens none of its own', async () => {
    await mountShell();
    const topics = new Set(streamMock.mock.calls.map((call) => [...call[0]].sort().join(',')));
    expect(topics).toEqual(new Set(['chat,jobs']));
  });

  it('a turn started on another device shows at once: followed, in the nav text and the tab title', async () => {
    await mountShell();
    expect(calls('chat/turns/active')).toBe(1); // on load: nothing ran yet
    expect(runnerMock.trackRun).not.toHaveBeenCalled();
    active = [
      {
        turn_id: 'turn-9',
        conversation_id: 'c9',
        case_id: null,
        started_at: '2026-10-11T10:00:00Z',
        label: 'Search‮ing logs',
        lookups: 2,
        status: 'running',
      },
    ];
    emit('chat.turn', frame('turn-9', 'started', { conversation_id: 'c9' }));
    await waitFor(() => expect(find('conv:c9')).toMatchObject({ status: 'running', parked: true, turnId: 'turn-9' }));
    expect(runnerMock.trackRun).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'conv:c9', kind: 'workspace', conversationId: 'c9', turnId: 'turn-9', label: 'Searching logs', lookups: 2 }),
    );
    expect(getChatActivity().workspace.status).toBe('running');
    expect(getChatActivity().workspace.text).toMatch(/^Chat: 1 answer in progress/);
    expect(document.title).toBe('● Agentic SOC');
  });

  it('a case turn started elsewhere marks the Case Manager the same way', async () => {
    await mountShell();
    active = [{ turn_id: 'turn-c', case_id: 'case-4', started_at: '2026-10-11T10:00:00Z', label: 'Thinking', lookups: 0, status: 'running' }];
    emit('chat.turn', frame('turn-c', 'started', { case_id: 'case-4' }));
    await waitFor(() => expect(find('case:case-4')).toMatchObject({ kind: 'case', caseId: 'case-4', status: 'running' }));
    expect(getChatActivity().case.status).toBe('running');
  });

  it('the frames of one turn make one lookup', async () => {
    await mountShell();
    active = [{ turn_id: 'turn-5', conversation_id: 'c5', status: 'running' }];
    emit('chat.turn', frame('turn-5', 'started', { conversation_id: 'c5' }));
    emit('chat.turn', frame('turn-5', 'progress', { conversation_id: 'c5', label: 'Thinking' }));
    emit('chat.turn', frame('turn-5', 'progress', { conversation_id: 'c5', label: 'Searching logs' }));
    await waitFor(() => expect(find('conv:c5')).not.toBeNull());
    await settle();
    expect(calls('chat/turns/active')).toBe(2);
    expect(runnerMock.trackRun).toHaveBeenCalledTimes(1);
  });

  it('frames of a turn this tab reads itself ask nothing and change nothing', async () => {
    putChatActivity(entry({ scope: 'conv:c1', conversationId: 'c1', turnId: 'turn-1', label: 'Searching logs', lookups: 1 }));
    await mountShell();
    const before = calls('chat/turns/active');
    emit('chat.turn', frame('turn-1', 'started', { conversation_id: 'c1' }));
    emit('chat.turn', frame('turn-1', 'progress', { conversation_id: 'c1', label: 'An older step', lookups: 0 }));
    await settle();
    expect(calls('chat/turns/active')).toBe(before);
    // Its own read keeps the label current: a throttled frame never sets it back.
    expect(find('conv:c1')).toMatchObject({ label: 'Searching logs', lookups: 1 });
    emit('chat.turn', frame('turn-1', 'finished', { conversation_id: 'c1' }));
    await settle();
    expect(runnerMock.wakeParkedRun).not.toHaveBeenCalled();
    expect(calls('chat/conversations')).toBe(1); // the load's only
  });

  it('a question this browser sent but not yet named is never followed as another device’s turn', async () => {
    // A new thread whose `turn.start` has not arrived: its turn could be any new one.
    putChatActivity(entry({ scope: 'draft:key-1', requestKey: 'key-1', title: 'Hunt for host X' }));
    await mountShell();
    active = [
      { turn_id: 'turn-mine', conversation_id: 'c-new', status: 'running' },
      { turn_id: 'turn-other', conversation_id: 'c-other', status: 'running' },
      // A case turn is told apart by its scope: it is followed at once.
      { turn_id: 'turn-case', case_id: 'case-2', status: 'running' },
    ];
    emit('chat.turn', frame('turn-mine', 'started', { conversation_id: 'c-new' }));
    await waitFor(() => expect(find('case:case-2')).not.toBeNull());
    expect(runnerMock.trackRun.mock.calls.map((call) => call[0].scope)).toEqual(['case:case-2']);
    // `turn.start` names it: the turns left for it are looked up again; it is this tab's.
    act(() => {
      rekeyChatActivity('draft:key-1', 'conv:c-new', { conversationId: 'c-new' });
      patchChatActivity('conv:c-new', { turnId: 'turn-mine' });
    });
    await waitFor(() => expect(find('conv:c-other')).not.toBeNull());
    expect(runnerMock.trackRun.mock.calls.map((call) => call[0].scope)).toEqual(['case:case-2', 'conv:c-other']);
    expect(find('conv:c-new')).toMatchObject({ source: 'local', turnId: 'turn-mine' });
    expect(find('conv:c-new')?.parked).toBeUndefined();
  });

  it('a parked run takes a frame’s step label, cleaned, and reads its outcome as soon as the turn ends', async () => {
    active = [{ turn_id: 'turn-p', conversation_id: 'cp', status: 'running', label: 'Thinking', lookups: 0 }];
    await mountShell();
    await waitFor(() => expect(find('conv:cp')?.parked).toBe(true));
    emit('chat.turn', frame('turn-p', 'progress', { conversation_id: 'cp', label: 'Writing\u{E0041} the­ answer', lookups: 3 }));
    expect(find('conv:cp')).toMatchObject({ label: 'Writing the answer', lookups: 3 });
    emit('chat.turn', frame('turn-p', 'finished', { conversation_id: 'cp' }));
    await waitFor(() => expect(runnerMock.wakeParkedRun).toHaveBeenCalledWith('turn-p'));
    // The frame is not the outcome: the run reads it (here a double), nothing settles here.
    expect(find('conv:cp')?.status).toBe('running');
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('an answer that ended before this tab could follow it is marked from the list; one on screen is not news', async () => {
    await mountShell();
    expect(calls('chat/conversations')).toBe(1);
    const release = viewChatActivity('conv:c-view');
    rows = [
      { id: 'c-fast', title: 'Fast answer', status: 'idle', unread: true, updated_at: '2026-10-11T10:00:00Z' },
      { id: 'c-view', title: 'On screen', status: 'idle', unread: true, updated_at: '2026-10-11T10:00:00Z' },
      { id: 'c-ask', title: 'Which host?', status: 'needs_input', unread: true, updated_at: '2026-10-11T10:00:00Z' },
    ];
    emit('chat.turn', frame('turn-fast', 'finished', { conversation_id: 'c-fast' }));
    emit('chat.turn', frame('turn-ask', 'needs_input', { conversation_id: 'c-ask' }));
    await waitFor(() => expect(find('conv:c-fast')?.status).toBe('unread'));
    expect(calls('chat/conversations')).toBe(2);
    expect(find('conv:c-ask')).toMatchObject({ status: 'needs_input' });
    expect(find('conv:c-view')).toBeNull();
    // Announced like a followed turn, once each: the answer, the question.
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledTimes(1));
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.success.mock.calls[0][0]).toBe('Answer ready');
    expect(toastMock.success.mock.calls[0][1]).toMatchObject({ id: 'chat-turn-fast', description: 'Fast answer' });
    expect(toastMock.warning.mock.calls[0][0]).toBe('A question needs your input');
    expect(toastMock.warning.mock.calls[0][1]).toMatchObject({ id: 'chat-turn-ask' });
    release();
  });

  it('an answer on screen, a failure, or a list that cannot be read is not announced', async () => {
    await mountShell();
    const release = viewChatActivity('conv:c-on');
    rows = [
      { id: 'c-on', title: 'On screen', status: 'idle', unread: true, updated_at: '2026-10-11T10:00:00Z' },
      { id: 'c-bad', title: 'Broke', status: 'failed', unread: true, updated_at: '2026-10-11T10:00:00Z' },
    ];
    emit('chat.turn', frame('turn-on', 'finished', { conversation_id: 'c-on' }));
    emit('chat.turn', frame('turn-bad', 'failed', { conversation_id: 'c-bad' }));
    await waitFor(() => expect(calls('chat/conversations')).toBe(2));
    await settle();
    expect(find('conv:c-on')).toBeNull();
    expect(find('conv:c-bad')).not.toBeNull();
    release();
    getMock.mockImplementation(async (path: string) => {
      if (path === 'chat/conversations') throw new Error('offline');
      return [];
    });
    act(() => putChatActivity(entry({ scope: 'conv:c-old', conversationId: 'c-old', status: 'unread', source: 'server' })));
    emit('chat.turn', frame('turn-old', 'finished', { conversation_id: 'c-old' }));
    await settle();
    for (const fn of [toastMock, toastMock.success, toastMock.warning, toastMock.error]) expect(fn).not.toHaveBeenCalled();
  });

  it('a turn this tab once held asks nothing when it ends or sends a late frame', async () => {
    putChatActivity(entry({ scope: 'conv:c-stop', conversationId: 'c-stop', turnId: 'turn-stop' }));
    await mountShell();
    // A forced Stop: this tab let go of it, the server finishes it.
    act(() => dropChatActivity('conv:c-stop'));
    active = [{ turn_id: 'turn-stop', conversation_id: 'c-stop', status: 'running' }];
    const before = calls('chat/turns/active');
    emit('chat.turn', frame('turn-stop', 'progress', { conversation_id: 'c-stop' }));
    emit('chat.turn', frame('turn-stop', 'finished', { conversation_id: 'c-stop' }));
    await settle();
    expect(calls('chat/turns/active')).toBe(before);
    expect(calls('chat/conversations')).toBe(1);
    expect(runnerMock.trackRun).not.toHaveBeenCalled();
    expect(find('conv:c-stop')).toBeNull();
  });

  it('after an overflow it asks what runs now and what the parked runs did', async () => {
    await mountShell();
    active = [{ turn_id: 'turn-o', conversation_id: 'co', status: 'running' }];
    emit('overflow', { dropped: 4 });
    await waitFor(() => expect(find('conv:co')).not.toBeNull());
    await waitFor(() => expect(runnerMock.pollParkedRuns).toHaveBeenCalled());
  });

  it('becoming visible looks for turns started elsewhere (with authentication off no frame says so)', async () => {
    authState.authEnabled = false;
    await mountShell();
    active = [{ turn_id: 'turn-v', conversation_id: 'cv', status: 'running' }];
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(find('conv:cv')).toMatchObject({ status: 'running', turnId: 'turn-v' }));
  });

  it('without access to chat (cases:read) frames are ignored', async () => {
    authState.can = false;
    await mountShell();
    active = [{ turn_id: 'turn-x', conversation_id: 'cx', status: 'running' }];
    emit('chat.turn', frame('turn-x', 'started', { conversation_id: 'cx' }));
    emit('overflow', { dropped: 1 });
    await settle();
    expect(calls('chat/turns/active')).toBe(0);
    expect(getChatActivity().entries).toEqual([]);
  });

  it('malformed frames ask nothing', async () => {
    await mountShell();
    const before = calls('chat/turns/active');
    emit('chat.turn', frame('../../etc', 'started'));
    emit('chat.turn', frame('turn-1', 'exploded'));
    emit('chat.turn', 'not a frame');
    emit('case.changed', { case_id: 'case-1' });
    await settle();
    expect(calls('chat/turns/active')).toBe(before);
  });

  it('once the chat observer is gone, frames go nowhere', async () => {
    const view = render(<ActivityEffects username="alice" onNavigate={vi.fn()} />);
    await settle();
    view.unmount();
    await settle();
    const before = calls('chat/turns/active');
    active = [{ turn_id: 'turn-late', conversation_id: 'cl', status: 'running' }];
    expect(() => relayChatFrame({ type: 'chat.turn', data: frame('turn-late', 'started', { conversation_id: 'cl' }) })).not.toThrow();
    await settle();
    expect(calls('chat/turns/active')).toBe(before);
  });
});


describe('an answer read on another console (chat.read)', () => {
  const unreadMark = (id: string, patch: Partial<ChatActivity> = {}) =>
    entry({ scope: `conv:${id}`, conversationId: id, status: 'unread', source: 'server', title: 'Hosts', ...patch });

  const listed = (id: string, patch: Record<string, unknown> = {}) => ({
    id,
    title: 'Hosts',
    status: 'idle',
    unread: true,
    updated_at: '2026-10-11T10:00:00Z',
    ...patch,
  });

  it('is no news here: its mark goes, a waiting question stays as one already seen', async () => {
    rows = [listed('c-read'), listed('c-ask', { status: 'needs_input' })];
    await mountShell();
    expect(find('conv:c-read')).toMatchObject({ status: 'unread' });
    expect(find('conv:c-ask')).toMatchObject({ status: 'needs_input', seen: false });
    expect(document.title).toBe('✓ Agentic SOC');
    emit('chat.read', { conversation_id: 'c-read' });
    emit('chat.read', { conversation_id: 'c-ask' });
    expect(find('conv:c-read')).toBeNull();
    expect(find('conv:c-ask')).toMatchObject({ status: 'needs_input', seen: true });
    expect(document.title).toBe('Agentic SOC');
    // A malformed frame changes nothing.
    act(() => putChatActivity(unreadMark('c-other')));
    emit('chat.read', { conversation_id: '../c-other' });
    emit('chat.read', 'c-other');
    expect(find('conv:c-other')).toMatchObject({ status: 'unread' });
  });

  it('a followed run that ends after the read leaves no mark and no toast', async () => {
    await mountShell();
    active = [
      { turn_id: 'turn-r', conversation_id: 'cr', status: 'running' },
      { turn_id: 'turn-s', conversation_id: 'cs', status: 'running' },
    ];
    emit('chat.turn', frame('turn-r', 'started', { conversation_id: 'cr' }));
    emit('chat.turn', frame('turn-s', 'started', { conversation_id: 'cs' }));
    await waitFor(() => expect(find('conv:cr')?.status).toBe('running'));
    await waitFor(() => expect(find('conv:cs')?.status).toBe('running'));
    emit('chat.turn', frame('turn-r', 'finished', { conversation_id: 'cr' }));
    emit('chat.turn', frame('turn-s', 'finished', { conversation_id: 'cs' }));
    // The analyst reads `cr` on the other device before this tab's run has read its end.
    emit('chat.read', { conversation_id: 'cr' });
    expect(find('conv:cr')?.status).toBe('running');
    act(() => {
      settleChatActivity('conv:cr', 'done');
      settleChatActivity('conv:cs', 'done');
    });
    expect(find('conv:cr')).toBeNull();
    expect(find('conv:cs')).toMatchObject({ status: 'unread' });
    // Only the answer nobody has read is announced.
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.success.mock.calls[0][1]).toMatchObject({ id: 'chat-turn-s' });
    expect(toastMock.dismiss).not.toHaveBeenCalled();
    // Read on the other device a moment later: the mark goes, and so does the toast.
    emit('chat.read', { conversation_id: 'cs' });
    expect(find('conv:cs')).toBeNull();
    expect(toastMock.dismiss).toHaveBeenCalledWith('chat-turn-s');
    expect(document.title).toBe('Agentic SOC');
  });

  it('a list read before the read does not bring the mark back', async () => {
    await mountShell();
    rows = [
      { id: 'c-fast', title: 'Fast answer', status: 'idle', unread: true, updated_at: '2026-10-11T10:00:00Z' },
      { id: 'c-q', title: 'Which host?', status: 'needs_input', unread: true, updated_at: '2026-10-11T10:00:00Z' },
    ];
    emit('chat.turn', frame('turn-fast', 'finished', { conversation_id: 'c-fast' }));
    emit('chat.turn', frame('turn-q', 'needs_input', { conversation_id: 'c-q' }));
    emit('chat.read', { conversation_id: 'c-fast' });
    emit('chat.read', { conversation_id: 'c-q' });
    await waitFor(() => expect(calls('chat/conversations')).toBe(2));
    await settle();
    expect(find('conv:c-fast')).toBeNull();
    expect(find('conv:c-q')).toMatchObject({ status: 'needs_input', seen: true });
    expect(document.title).toBe('Agentic SOC');
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it('a new turn in that conversation is news again', async () => {
    await mountShell();
    emit('chat.read', { conversation_id: 'c-again' });
    active = [{ turn_id: 'turn-2', conversation_id: 'c-again', status: 'running' }];
    emit('chat.turn', frame('turn-2', 'started', { conversation_id: 'c-again' }));
    await waitFor(() => expect(find('conv:c-again')?.status).toBe('running'));
    act(() => settleChatActivity('conv:c-again', 'done'));
    expect(find('conv:c-again')).toMatchObject({ status: 'unread' });
    expect(toastMock.success).toHaveBeenCalledTimes(1);
  });

  it('holds only for a moment, and not past an overflow (a new turn’s frame may be lost)', async () => {
    await mountShell();
    FRAME_TIMING.readHoldMs = 20;
    emit('chat.read', { conversation_id: 'c-old' });
    await settle(40);
    act(() => putChatActivity(unreadMark('c-old')));
    expect(find('conv:c-old')).toMatchObject({ status: 'unread' });
    FRAME_TIMING.readHoldMs = 30_000;
    emit('chat.read', { conversation_id: 'c-lost' });
    emit('overflow', { dropped: 2 });
    act(() => putChatActivity(unreadMark('c-lost')));
    expect(find('conv:c-lost')).toMatchObject({ status: 'unread' });
  });

  it('without access to chat (cases:read) a read frame changes nothing', async () => {
    authState.can = false;
    await mountShell();
    act(() => putChatActivity(unreadMark('c-keep')));
    emit('chat.read', { conversation_id: 'c-keep' });
    expect(find('conv:c-keep')).toMatchObject({ status: 'unread' });
  });
});

describe('a turn seen on another console, and the grace of a followed turn', () => {
  const GRACE = 60;
  beforeEach(() => {
    FRAME_TIMING.followGraceMs = GRACE;
  });

  /** Follow another console's turn (a frame, then `turns/active`), as the shell does. */
  async function follow(turnId: string, where: { conversation_id?: string; case_id?: string }) {
    active = [{ turn_id: turnId, status: 'running', ...where }];
    emit('chat.turn', frame(turnId, 'started', where));
    const scope = where.case_id ? `case:${where.case_id}` : `conv:${where.conversation_id}`;
    await waitFor(() => expect(find(scope)).toMatchObject({ status: 'running', turnId }));
    active = [];
    return scope;
  }

  /** The runner reads the end of a followed turn (the double settles it as the runner does). */
  function ends(scope: string, outcome: 'done' | 'error' | 'needs_input') {
    act(() => settleChatActivity(scope, outcome, true, { followed: true }));
  }

  const seenFrames = () => postMock.mock.calls.map((call) => call[0]);

  it('a case chat answer read on the console that asked leaves no mark, no toast and no ✓ here', async () => {
    await mountShell();
    const scope = await follow('turn-c4', { case_id: 'case-4' });
    emit('chat.turn', frame('turn-c4', 'finished', { case_id: 'case-4' }));
    ends(scope, 'done');
    // The grace: it still reads as running, and nothing is announced yet.
    expect(find(scope)?.status).toBe('running');
    expect(document.title).toBe('● Agentic SOC');
    // The asking console shows it and says so.
    emit('chat.read', { turn_id: 'turn-c4', case_id: 'case-4' });
    await settle(GRACE + 40);
    expect(find(scope)).toBeNull();
    expect(getChatActivity().case.status).toBeNull();
    expect(document.title).toBe('Agentic SOC');
    for (const fn of [toastMock.success, toastMock.warning, toastMock.error]) expect(fn).not.toHaveBeenCalled();
    // Nothing went on screen here: this tab tells nobody.
    expect(seenFrames()).toEqual([]);
  });

  it('a failure shown on the console that asked leaves no failed mark and no error toast here', async () => {
    await mountShell();
    const scope = await follow('turn-f1', { conversation_id: 'cf' });
    // Its "seen" may even come before this tab reads the end.
    emit('chat.read', { turn_id: 'turn-f1', conversation_id: 'cf' });
    ends(scope, 'error');
    await settle(GRACE + 40);
    expect(find(scope)).toBeNull();
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(getChatActivity().workspace.status).toBeNull();
  });

  it('a mark nobody had seen goes, with its toast, once the console that asked shows it later', async () => {
    await mountShell();
    const caseScope = await follow('turn-c5', { case_id: 'case-5' });
    const failScope = await follow('turn-f2', { conversation_id: 'cf2' });
    ends(caseScope, 'done');
    ends(failScope, 'error');
    await settle(GRACE + 40);
    // Nobody saw them in the grace: the marks and the toasts land.
    expect(find(caseScope)).toMatchObject({ status: 'unread' });
    expect(find(failScope)).toMatchObject({ status: 'failed' });
    expect(document.title).toBe('✓ Agentic SOC');
    expect(toastMock.success.mock.calls[0][1]).toMatchObject({ id: 'chat-turn-c5', description: 'Case case-5' });
    expect(toastMock.error.mock.calls[0][1]).toMatchObject({ id: 'chat-turn-f2' });
    // The analyst opens them on the other console.
    emit('chat.read', { turn_id: 'turn-c5', case_id: 'case-5' });
    emit('chat.read', { turn_id: 'turn-f2', conversation_id: 'cf2' });
    expect(find(caseScope)).toBeNull();
    expect(find(failScope)).toBeNull();
    expect(toastMock.dismiss).toHaveBeenCalledWith('chat-turn-c5');
    expect(toastMock.dismiss).toHaveBeenCalledWith('chat-turn-f2');
    expect(document.title).toBe('Agentic SOC');
  });

  it('an answer read on the asking console within the grace is never announced here; one nobody reads is', async () => {
    await mountShell();
    const read = await follow('turn-r', { conversation_id: 'cr' });
    const unread = await follow('turn-u', { conversation_id: 'cu' });
    ends(read, 'done');
    ends(unread, 'done');
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(document.title).toBe('● Agentic SOC');
    // The asking console marks `cr` read a moment later (after its list refetch).
    await settle(GRACE / 3);
    emit('chat.read', { conversation_id: 'cr' });
    await settle(GRACE + 40);
    expect(find(read)).toBeNull();
    expect(find(unread)).toMatchObject({ status: 'unread' });
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.success.mock.calls[0][1]).toMatchObject({ id: 'chat-turn-u' });
    expect(toastMock.dismiss).not.toHaveBeenCalled();
    expect(document.title).toBe('✓ Agentic SOC');
  });

  it('a turn seen elsewhere drops exactly its own mark: a newer one in that chat, and its toast, stay', async () => {
    await mountShell();
    // This console asked T2 in case X and in conversation cw, and left: marks and toasts.
    act(() => putChatActivity(entry({ scope: 'case:case-x', kind: 'case', caseId: 'case-x', turnId: 'turn-T2' })));
    act(() => settleChatActivity('case:case-x', 'done'));
    act(() => putChatActivity(entry({ scope: 'conv:cw', conversationId: 'cw', turnId: 'turn-W2' })));
    act(() => settleChatActivity('conv:cw', 'error'));
    expect(find('case:case-x')).toMatchObject({ status: 'unread', turnId: 'turn-T2' });
    expect(find('conv:cw')).toMatchObject({ status: 'failed', turnId: 'turn-W2' });
    expect(document.title).toBe('✓ Agentic SOC');
    // Another console shows an EARLIER turn of the same case and conversation.
    emit('chat.read', { turn_id: 'turn-T1', case_id: 'case-x' });
    emit('chat.read', { turn_id: 'turn-W1', conversation_id: 'cw' });
    expect(find('case:case-x')).toMatchObject({ status: 'unread', turnId: 'turn-T2' });
    expect(find('conv:cw')).toMatchObject({ status: 'failed', turnId: 'turn-W2' });
    expect(toastMock.dismiss).not.toHaveBeenCalled();
    expect(document.title).toBe('✓ Agentic SOC');
    // The turn itself, shown there: its mark and toast go.
    emit('chat.read', { turn_id: 'turn-T2', case_id: 'case-x' });
    expect(find('case:case-x')).toBeNull();
    expect(toastMock.dismiss).toHaveBeenCalledWith('chat-turn-T2');
  });

  it('a look after the server forgot the turn still clears it: the frame names the turn alone', async () => {
    await mountShell();
    act(() => putChatActivity(entry({ scope: 'case:case-late', kind: 'case', caseId: 'case-late', turnId: 'turn-late' })));
    act(() => settleChatActivity('case:case-late', 'done'));
    expect(find('case:case-late')).toMatchObject({ status: 'unread' });
    emit('chat.read', { turn_id: 'turn-late' });
    expect(find('case:case-late')).toBeNull();
    expect(toastMock.dismiss).toHaveBeenCalledWith('chat-turn-late');
    expect(document.title).toBe('Agentic SOC');
  });

  it('every answer a case chat lists is told once', async () => {
    await mountShell();
    act(() => showChatTurns(['turn-a', null, 'turn-b', 'turn-a']));
    act(() => showChatTurns(['turn-a', 'turn-b']));
    await settle();
    expect(seenFrames()).toEqual(['chat/turns/turn-a/seen', 'chat/turns/turn-b/seen']);
  });

  it('a question shown on the asking console stays, but as one already seen, with no toast', async () => {
    await mountShell();
    const scope = await follow('turn-q', { conversation_id: 'cq' });
    ends(scope, 'needs_input');
    emit('chat.read', { turn_id: 'turn-q', conversation_id: 'cq' });
    await settle(GRACE + 40);
    expect(find(scope)).toMatchObject({ status: 'needs_input', seen: true });
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it('a chat opened here during the grace is read here: no mark, and the other consoles hear it', async () => {
    await mountShell();
    const scope = await follow('turn-v', { case_id: 'case-v' });
    ends(scope, 'done');
    const release = viewChatActivity(scope);
    release();
    await settle(GRACE + 40);
    expect(find(scope)).toBeNull();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(seenFrames()).toEqual(['chat/turns/turn-v/seen']);
  });

  it('a new turn in that chat during the grace is followed at once', async () => {
    await mountShell();
    const scope = await follow('turn-n1', { conversation_id: 'cn' });
    ends(scope, 'done');
    expect(isChatActivitySettling(scope)).toBe(true);
    await follow('turn-n2', { conversation_id: 'cn' });
    // The earlier turn's grace ends with it: nothing of it will land.
    expect(isChatActivitySettling(scope)).toBe(false);
    await settle(GRACE + 40);
    // The new turn reads on; the one before it (the analyst asked again there) is no news.
    expect(find(scope)).toMatchObject({ status: 'running', turnId: 'turn-n2' });
    expect(runnerMock.trackRun.mock.calls.map((call) => call[0].turnId)).toEqual(['turn-n1', 'turn-n2']);
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('a turn this tab started is never held back by the grace', async () => {
    await mountShell();
    act(() => putChatActivity(entry({ scope: 'case:case-own', kind: 'case', caseId: 'case-own', turnId: 'turn-own' })));
    act(() => settleChatActivity('case:case-own', 'done'));
    expect(find('case:case-own')).toMatchObject({ status: 'unread' });
    expect(toastMock.success).toHaveBeenCalledTimes(1);
  });

  it('a turn shown here tells the other consoles once; a look elsewhere, a listed mark or auth off tells nobody', async () => {
    await mountShell();
    // Settled on screen (a case chat).
    act(() => putChatActivity(entry({ scope: 'case:case-8', kind: 'case', caseId: 'case-8', turnId: 'turn-8' })));
    const release = viewChatActivity('case:case-8');
    act(() => settleChatActivity('case:case-8', 'done'));
    // A failure looked at later, twice.
    act(() => putChatActivity(entry({ scope: 'conv:c9', conversationId: 'c9', turnId: 'turn-9', status: 'failed' })));
    act(() => viewChatActivity('conv:c9')());
    act(() => putChatActivity(entry({ scope: 'conv:c9', conversationId: 'c9', turnId: 'turn-9', status: 'failed' })));
    act(() => viewChatActivity('conv:c9')());
    // Seen on another console: that console already told everyone.
    act(() => putChatActivity(entry({ scope: 'conv:c10', conversationId: 'c10', turnId: 'turn-10', status: 'unread' })));
    emit('chat.read', { turn_id: 'turn-10', conversation_id: 'c10' });
    // A mark from the list names no turn.
    act(() => putChatActivity(entry({ scope: 'conv:c11', conversationId: 'c11', status: 'unread', source: 'server' })));
    act(() => viewChatActivity('conv:c11')());
    await settle();
    expect(seenFrames()).toEqual(['chat/turns/turn-8/seen', 'chat/turns/turn-9/seen']);
    release();
  });

  it('with authentication off no frame reaches anyone: nothing is told and nothing waits', async () => {
    authState.authEnabled = false;
    await mountShell();
    act(() => putChatActivity(entry({ scope: 'case:case-x', kind: 'case', caseId: 'case-x', turnId: 'turn-x' })));
    const release = viewChatActivity('case:case-x');
    act(() => settleChatActivity('case:case-x', 'done'));
    release();
    act(() => putChatActivity(entry({ scope: 'conv:cy', conversationId: 'cy', turnId: 'turn-y' })));
    act(() => settleChatActivity('conv:cy', 'done', true, { followed: true }));
    expect(find('conv:cy')).toMatchObject({ status: 'unread' });
    await settle();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('a seen request that fails is quiet', async () => {
    postMock.mockRejectedValue(new Error('offline'));
    await mountShell();
    act(() => putChatActivity(entry({ scope: 'case:case-z', kind: 'case', caseId: 'case-z', turnId: 'turn-z' })));
    const release = viewChatActivity('case:case-z');
    act(() => settleChatActivity('case:case-z', 'done'));
    await settle();
    expect(postMock).toHaveBeenCalledTimes(1);
    release();
  });

  it('a sign-out during the grace leaves nothing behind', async () => {
    await mountShell();
    const scope = await follow('turn-s', { conversation_id: 'cso' });
    ends(scope, 'done');
    act(() => clearChatActivity());
    await settle(GRACE + 40);
    expect(getChatActivity().entries).toEqual([]);
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
