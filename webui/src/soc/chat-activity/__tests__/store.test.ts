/**
 * The chat activity store (Round 12, SPEC D13): entries per scope, the settle rules
 * (on screen → simply ends; elsewhere → unread / failed / needs input), "seen", other
 * tabs' messages, the sink for this tab's own changes, and sign-out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyChatActivityMessage,
  clearChatActivity,
  dropChatActivity,
  getChatActivity,
  isChatActivityViewed,
  markChatActivitySeen,
  markViewedChatActivitySeen,
  onChatActivity,
  patchChatActivity,
  putChatActivity,
  rekeyChatActivity,
  setAnimatedBrand,
  setChatActivitySink,
  settleChatActivity,
  subscribeChatActivity,
  viewChatActivity,
  type ChatActivity,
  type ChatActivityMessage,
  type ChatActivitySettled,
} from '../activity';

function entry(patch: Partial<ChatActivity> & { scope: string }): ChatActivity {
  return {
    kind: 'workspace',
    conversationId: null,
    caseId: null,
    turnId: null,
    requestKey: 'key-1',
    title: 'Investigate host X',
    label: null,
    lookups: 0,
    status: 'running',
    startedAt: 1,
    source: 'local',
    ...patch,
  };
}

const find = (scope: string) => getChatActivity().entries.find((item) => item.scope === scope) ?? null;

let sent: ChatActivityMessage[] = [];
let settled: ChatActivitySettled[] = [];
let releases: Array<() => void> = [];
let offSettled: () => void = () => undefined;

beforeEach(() => {
  clearChatActivity();
  sent = [];
  settled = [];
  releases = [];
  setChatActivitySink((message) => sent.push(message));
  offSettled = onChatActivity('settled', (event) => settled.push(event));
});

afterEach(() => {
  offSettled();
  for (const release of releases) release();
  setChatActivitySink(null);
  vi.restoreAllMocks();
});

const view = (scope: string) => {
  const release = viewChatActivity(scope);
  releases.push(release);
  return release;
};

describe('chat activity store', () => {
  it('adds, patches, re-keys and drops entries, and notifies subscribers', () => {
    const listener = vi.fn();
    const off = subscribeChatActivity(listener);
    putChatActivity(entry({ scope: 'draft:key-1' }));
    patchChatActivity('draft:key-1', { label: 'Searching logs', lookups: 2 });
    expect(find('draft:key-1')).toMatchObject({ label: 'Searching logs', lookups: 2 });
    rekeyChatActivity('draft:key-1', 'conv:c1', { conversationId: 'c1' });
    expect(find('draft:key-1')).toBeNull();
    expect(find('conv:c1')).toMatchObject({ conversationId: 'c1', label: 'Searching logs' });
    dropChatActivity('conv:c1');
    expect(getChatActivity().entries).toEqual([]);
    expect(listener).toHaveBeenCalled();
    off();
  });

  it('never lets a server report override what a tab streams or hears from another tab', () => {
    putChatActivity(entry({ scope: 'conv:c1', label: 'Writing the answer' }));
    putChatActivity(entry({ scope: 'conv:c1', label: 'Thinking', source: 'server' }));
    expect(find('conv:c1')).toMatchObject({ source: 'local', label: 'Writing the answer' });
    putChatActivity(entry({ scope: 'conv:c2', source: 'server' }));
    putChatActivity(entry({ scope: 'conv:c2', source: 'server', lookups: 3 }));
    expect(find('conv:c2')?.lookups).toBe(3);
  });

  it('settles off screen as unread, failed or waiting, and tells the shell once', () => {
    putChatActivity(entry({ scope: 'conv:a' }));
    putChatActivity(entry({ scope: 'conv:b' }));
    putChatActivity(entry({ scope: 'conv:c' }));
    putChatActivity(entry({ scope: 'conv:d' }));
    settleChatActivity('conv:a', 'done');
    settleChatActivity('conv:b', 'error');
    settleChatActivity('conv:c', 'needs_input');
    settleChatActivity('conv:d', 'stopped');
    expect(find('conv:a')).toMatchObject({ status: 'unread', seen: false, label: null });
    expect(find('conv:b')?.status).toBe('failed');
    expect(find('conv:c')).toMatchObject({ status: 'needs_input', seen: false });
    expect(find('conv:d')).toBeNull();
    expect(settled.map((event) => [event.activity.scope, event.outcome, event.viewed])).toEqual([
      ['conv:a', 'done', false],
      ['conv:b', 'error', false],
      ['conv:c', 'needs_input', false],
      ['conv:d', 'stopped', false],
    ]);
  });

  it('simply ends a turn the analyst is looking at; a question still waits, already seen', () => {
    putChatActivity(entry({ scope: 'conv:a' }));
    putChatActivity(entry({ scope: 'conv:q' }));
    view('conv:a');
    view('conv:q');
    expect(isChatActivityViewed('conv:a')).toBe(true);
    settleChatActivity('conv:a', 'done');
    settleChatActivity('conv:q', 'needs_input');
    expect(find('conv:a')).toBeNull();
    expect(find('conv:q')).toMatchObject({ status: 'needs_input', seen: true });
    expect(settled.every((event) => event.viewed)).toBe(true);
  });

  it('counts a hidden tab as not looking, and reads the answer once the tab is visible', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    putChatActivity(entry({ scope: 'conv:a' }));
    view('conv:a');
    settleChatActivity('conv:a', 'done');
    expect(find('conv:a')?.status).toBe('unread');
    visibility.mockReturnValue('visible');
    markViewedChatActivitySeen();
    expect(find('conv:a')).toBeNull();
  });

  it('marks a chat seen when it comes on screen, and keeps counting views', () => {
    putChatActivity(entry({ scope: 'conv:a', status: 'unread' }));
    putChatActivity(entry({ scope: 'conv:f', status: 'failed' }));
    const releaseA = view('conv:a');
    expect(find('conv:a')).toBeNull();
    markChatActivitySeen('conv:f');
    expect(find('conv:f')).toBeNull();
    const second = view('conv:a');
    releaseA();
    expect(isChatActivityViewed('conv:a')).toBe(true);
    second();
    expect(isChatActivityViewed('conv:a')).toBe(false);
    // A running turn is never "seen" away.
    putChatActivity(entry({ scope: 'conv:r' }));
    markChatActivitySeen('conv:r');
    expect(find('conv:r')?.status).toBe('running');
  });

  it('sends only this tab’s own changes to other tabs', () => {
    putChatActivity(entry({ scope: 'conv:a' }));
    putChatActivity(entry({ scope: 'conv:s', source: 'server' }));
    markChatActivitySeen('conv:none');
    dropChatActivity('conv:a');
    expect(sent.map((message) => message.t)).toEqual(['put', 'drop']);
    sent = [];
    applyChatActivityMessage({ t: 'put', a: entry({ scope: 'conv:p' }) });
    applyChatActivityMessage({ t: 'drop', s: 'conv:p' });
    expect(sent).toEqual([]);
  });

  it('stores another tab’s turn as a peer entry and runs the settle rules when it finishes', () => {
    applyChatActivityMessage({ t: 'put', a: entry({ scope: 'conv:p' }) });
    expect(find('conv:p')?.source).toBe('peer');
    applyChatActivityMessage({ t: 'put', a: entry({ scope: 'conv:p', status: 'unread' }) });
    expect(find('conv:p')).toMatchObject({ status: 'unread', source: 'peer' });
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ outcome: 'done', viewed: false });
    // A tab's own turn is never replaced by another tab's report of it.
    putChatActivity(entry({ scope: 'conv:mine', label: 'Mine' }));
    applyChatActivityMessage({ t: 'put', a: entry({ scope: 'conv:mine', label: 'Theirs' }) });
    expect(find('conv:mine')?.label).toBe('Mine');
    applyChatActivityMessage({ t: 'seen', s: 'conv:p' });
    expect(find('conv:p')).toBeNull();
    applyChatActivityMessage({ t: 'clear' });
    expect(getChatActivity().entries).toEqual([]);
  });

  it('forgets everything on sign-out and tells the runner to stop reading', () => {
    const cleared = vi.fn();
    const off = onChatActivity('clear', cleared);
    putChatActivity(entry({ scope: 'conv:a' }));
    sent = [];
    clearChatActivity();
    expect(getChatActivity().entries).toEqual([]);
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([{ t: 'clear' }]);
    off();
  });

  it('remembers the brand-ring switch', () => {
    setAnimatedBrand(false);
    expect(getChatActivity().animatedBrand).toBe(false);
    setAnimatedBrand(true);
    expect(getChatActivity().animatedBrand).toBe(true);
  });
});
