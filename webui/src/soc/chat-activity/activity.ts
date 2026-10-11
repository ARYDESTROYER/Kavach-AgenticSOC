/**
 * Chat activity writers (Round 12, SPEC D13): the rules behind the store's snapshot.
 * Imported only by lazy chunks (the turn runner, the chat views, `ActivityEffects`), so
 * none of this rides the first-paint bundle; `store.ts` keeps the eager core. Every
 * write goes through `commit`, which also precomputes the navigation summaries the eager
 * glyph hosts read (`workspace`, `case`, `all`).
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
  getChatActivity,
  writeChatActivity,
  type ChatActivity,
  type ChatActivityStatus,
  type ChatActivitySummary,
} from './store';

export * from './store';

export type ChatActivityOutcome = 'done' | 'needs_input' | 'error' | 'stopped';

/** Messages for other tabs (`ActivityEffects` sends them on a BroadcastChannel). */
export type ChatActivityMessage =
  | { t: 'put'; a: ChatActivity }
  | { t: 'drop' | 'seen'; s: string }
  | { t: 'clear' };

export interface ChatActivitySettled {
  activity: ChatActivity;
  outcome: ChatActivityOutcome;
  /** The analyst had this chat on screen (no toast, no unread mark). */
  viewed: boolean;
}

type Listener = () => void;

const settledListeners = new Set<(event: ChatActivitySettled) => void>();
const clearListeners = new Set<Listener>();
const viewing = new Map<string, number>();
let sink: ((message: ChatActivityMessage) => void) | null = null;

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
const find = (scope: string) => getChatActivity().entries.find((entry) => entry.scope === scope);

/** Most important first: [state, one, several]. */
const PHRASES: Array<[ChatActivityStatus, string, string]> = [
  ['running', 'answer in progress', 'answers in progress'],
  ['needs_input', 'question needs your input', 'questions need your input'],
  ['failed', 'answer failed', 'answers failed'],
  ['unread', 'new answer', 'new answers'],
];

/**
 * The glyph state and its text for a set of entries ("Chat: 1 answer in progress:
 * <title>"). A question the analyst has already looked at keeps its dot but is not
 * repeated in the text.
 */
export function describeChatActivity(entries: readonly ChatActivity[], label = 'Chat'): ChatActivitySummary {
  const parts: string[] = [];
  let status: ChatActivityStatus | null = null;
  for (const [kind, one, several] of PHRASES) {
    const group = entries.filter((entry) => entry.status === kind);
    if (!group.length) continue;
    status ??= kind;
    const fresh = group.filter((entry) => !entry.seen);
    if (fresh.length === 1) parts.push(`1 ${one}${fresh[0].title ? `: ${fresh[0].title}` : ''}`);
    else if (fresh.length) parts.push(`${fresh.length} ${several}`);
  }
  return { status, text: parts.length ? `${label}: ${parts.join('; ')}` : '' };
}

/** The previous summary while nothing it shows changed (hosts select it by identity). */
const keep = (previous: ChatActivitySummary, next: ChatActivitySummary) =>
  previous.status === next.status && previous.text === next.text ? previous : next;

/** The one write path: the entries, the brand switch, and the summaries derived from them. */
function commit(entries: readonly ChatActivity[], animatedBrand = getChatActivity().animatedBrand): void {
  const before = getChatActivity();
  writeChatActivity({
    entries,
    animatedBrand,
    workspace: keep(before.workspace, describeChatActivity(entries.filter((entry) => entry.kind === 'workspace'))),
    case: keep(
      before.case,
      describeChatActivity(
        entries.filter((entry) => entry.kind === 'case'),
        'Case chat',
      ),
    ),
    all: keep(before.all, describeChatActivity(entries)),
  });
}

function replace(entry: ChatActivity | null, scope: string): void {
  const rest = getChatActivity().entries.filter((item) => item.scope !== scope);
  commit(entry ? [entry, ...rest] : rest);
}

function send(message: ChatActivityMessage, local: boolean): void {
  if (local) sink?.(message);
}

/** Where this tab's own changes go (the BroadcastChannel); `null` detaches. */
export function setChatActivitySink(next: ((message: ChatActivityMessage) => void) | null): void {
  sink = next;
}

/** Sign-out or another user: forget everything and stop this tab's turns (the runner listens). */
export function clearChatActivity(local = true): void {
  if (getChatActivity().entries.length) commit([]);
  for (const listener of Array.from(clearListeners)) listener();
  send({ t: 'clear' }, local);
}

/** `settled` fires once per finished turn; `clear` on sign-out (the runner aborts). */
export function onChatActivity(event: 'settled', listener: (event: ChatActivitySettled) => void): () => void;
export function onChatActivity(event: 'clear', listener: Listener): () => void;
export function onChatActivity(
  event: 'settled' | 'clear',
  listener: Listener | ((event: ChatActivitySettled) => void),
): () => void {
  if (event === 'clear') {
    const plain = listener as Listener;
    clearListeners.add(plain);
    return () => clearListeners.delete(plain);
  }
  const typed = listener as (event: ChatActivitySettled) => void;
  settledListeners.add(typed);
  return () => settledListeners.delete(typed);
}

export function setAnimatedBrand(value: boolean): void {
  const current = getChatActivity();
  if (current.animatedBrand === value) return;
  commit(current.entries, value);
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
