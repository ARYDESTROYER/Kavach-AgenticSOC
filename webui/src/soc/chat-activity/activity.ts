/**
 * Chat activity writers (Round 12, SPEC D13): the rules behind the store's snapshot.
 * Imported only by lazy chunks (the turn runner, the chat views, `ActivityEffects`), so
 * none of this rides the first-paint bundle; `store.ts` keeps the eager core.
 *
 * Writers:
 *  - the turn runner (`soc/chat/turn-runner.ts`) for this tab's own turns;
 *  - `ActivityEffects` for other tabs (BroadcastChannel) and for turns the server
 *    reports (`GET /api/chat/turns/active`, `chat.turn` frames, the conversation list's
 *    `unread` / `needs_input`);
 *  - the chat views, which register what is on screen (`viewChatActivity`).
 *
 * A turn that finishes on screen simply ends; elsewhere it becomes `unread` (an answer)
 * or `failed`, and a clarifying question stays as `needs_input` until it is answered.
 */
import {
  BRAND_KEY,
  clearChatActivity,
  getChatActivity,
  onChatActivityClear,
  sendChatActivity,
  writeChatActivity,
  type ChatActivity,
  type ChatActivityMessage,
  type ChatActivityStatus,
} from './store';

export * from './store';

export type ChatActivityOutcome = 'done' | 'needs_input' | 'error' | 'stopped';

export interface ChatActivitySettled {
  activity: ChatActivity;
  outcome: ChatActivityOutcome;
  /** The analyst had this chat on screen (no toast, no unread mark). */
  viewed: boolean;
}

type Listener = () => void;

const settledListeners = new Set<(event: ChatActivitySettled) => void>();
const viewing = new Map<string, number>();

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
const find = (scope: string) => getChatActivity().entries.find((entry) => entry.scope === scope);

function replace(entry: ChatActivity | null, scope: string): void {
  const rest = getChatActivity().entries.filter((item) => item.scope !== scope);
  writeChatActivity(entry ? [entry, ...rest] : rest);
}

function send(message: ChatActivityMessage, local: boolean): void {
  if (local) sendChatActivity(message);
}

/** `settled` fires once per finished turn; `clear` on sign-out (the runner aborts). */
export function onChatActivity(event: 'settled', listener: (event: ChatActivitySettled) => void): () => void;
export function onChatActivity(event: 'clear', listener: Listener): () => void;
export function onChatActivity(
  event: 'settled' | 'clear',
  listener: Listener | ((event: ChatActivitySettled) => void),
): () => void {
  if (event === 'clear') return onChatActivityClear(listener as Listener);
  const typed = listener as (event: ChatActivitySettled) => void;
  settledListeners.add(typed);
  return () => settledListeners.delete(typed);
}

export function setAnimatedBrand(value: boolean): void {
  const current = getChatActivity();
  if (current.animatedBrand === value) return;
  writeChatActivity(current.entries, value);
  try {
    window.localStorage.setItem(BRAND_KEY, value ? '1' : '0');
  } catch {
    /* storage blocked: the switch still applies for this page */
  }
}

/**
 * Add or replace an entry. A server report never overrides what a tab is streaming
 * itself (`local`) or hears from another tab (`peer`).
 */
export function putChatActivity(entry: ChatActivity, local = entry.source === 'local'): void {
  const current = find(entry.scope);
  if (entry.source === 'server' && current && current.source !== 'server') return;
  replace(entry, entry.scope);
  send({ t: 'put', a: entry }, local);
}

export function patchChatActivity(scope: string, patch: Partial<ChatActivity>): void {
  const current = find(scope);
  if (current) putChatActivity({ ...current, ...patch, scope });
}

/** A new thread's turn learnt its conversation id (`draft:` → `conv:`). */
export function rekeyChatActivity(from: string, to: string, patch: Partial<ChatActivity> = {}): void {
  const current = find(from);
  if (!current || from === to) return;
  dropChatActivity(from);
  putChatActivity({ ...current, ...patch, scope: to });
}

export function dropChatActivity(scope: string, local = true): void {
  if (!find(scope)) return;
  replace(null, scope);
  send({ t: 'drop', s: scope }, local);
}

export function isChatActivityViewed(scope: string): boolean {
  return (viewing.get(scope) ?? 0) > 0 && visible();
}

/** A turn finished: on screen it simply ends; elsewhere it leaves its mark. */
export function settleChatActivity(scope: string, outcome: ChatActivityOutcome, local = true): void {
  const current = find(scope);
  if (!current) return;
  const viewed = isChatActivityViewed(scope);
  const status: ChatActivityStatus | null =
    outcome === 'needs_input' ? 'needs_input' : viewed || outcome === 'stopped' ? null : outcome === 'done' ? 'unread' : 'failed';
  if (status) putChatActivity({ ...current, status, seen: viewed, label: null }, local);
  else dropChatActivity(scope, local);
  const event = { activity: current, outcome, viewed };
  for (const listener of Array.from(settledListeners)) listener(event);
}

/** The analyst looked at this chat: an answer or failure is read; a question stays. */
export function markChatActivitySeen(scope: string, local = true): void {
  const current = find(scope);
  if (!current || current.status === 'running' || current.seen) return;
  if (current.status === 'needs_input') replace({ ...current, seen: true }, scope);
  else replace(null, scope);
  send({ t: 'seen', s: scope }, local);
}

/** Mark every on-screen chat seen (the tab became visible again). */
export function markViewedChatActivitySeen(): void {
  for (const [scope, count] of viewing) if (count > 0) markChatActivitySeen(scope);
}

/** Register a chat that is on screen; returns the release. */
export function viewChatActivity(scope: string): () => void {
  viewing.set(scope, (viewing.get(scope) ?? 0) + 1);
  if (visible()) markChatActivitySeen(scope);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (viewing.get(scope) ?? 1) - 1;
    if (count > 0) viewing.set(scope, count);
    else viewing.delete(scope);
  };
}

/** Apply another tab's change (never sent back out). */
export function applyChatActivityMessage(message: ChatActivityMessage): void {
  if (message.t === 'clear') {
    clearChatActivity(false);
  } else if (message.t !== 'put') {
    if (message.t === 'drop') dropChatActivity(message.s, false);
    else markChatActivitySeen(message.s, false);
  } else {
    const before = find(message.a.scope);
    if (before?.source === 'local') return;
    const entry: ChatActivity = { ...message.a, source: 'peer' };
    if (before?.status === 'running' && entry.status !== 'running') {
      // The other tab settled it: run the same rules here (on screen → read).
      replace({ ...before, source: 'peer' }, entry.scope);
      settleChatActivity(entry.scope, entry.status === 'unread' ? 'done' : entry.status === 'failed' ? 'error' : 'needs_input', false);
    } else {
      putChatActivity(entry, false);
    }
  }
}
