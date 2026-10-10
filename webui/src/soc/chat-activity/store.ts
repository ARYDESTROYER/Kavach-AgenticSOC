/**
 * Chat activity store: the app-level "agent is working" state (Round 12, SPEC D13).
 *
 * A tiny external store read through `useSyncExternalStore`. It is on the first-paint
 * graph (the navigation glyph, the brand ring and the shell monitor read it), so it
 * imports React only: never the chat modules, the API layer or the stream normaliser.
 *
 * Writers:
 *  - the lazy turn runner (`soc/chat/turn-runner.ts`) for this tab's own turns;
 *  - the lazy effects module (`ActivityEffects.tsx`) for other tabs (BroadcastChannel)
 *    and for turns the server reports (`GET /api/chat/turns/active`, `chat.turn`
 *    frames, the conversation list's `unread` / `needs_input`).
 *
 * Keys (`scope`): `conv:<conversation id>`, `draft:<request key>` (a new thread before
 * `turn.start` names it), `case:<case id>`, `turn:<turn id>` (a server turn with neither).
 *
 * Memory only, never storage: titles are prompt-derived (#9 untrusted text, rendered as
 * text everywhere). Cleared on sign-out and on a change of user.
 */
import * as React from 'react';

export type ChatActivityStatus = 'running' | 'needs_input' | 'unread' | 'failed';
export type ChatActivityOutcome = 'done' | 'needs_input' | 'error' | 'stopped';

export interface ChatActivity {
  scope: string;
  kind: 'workspace' | 'case';
  conversationId: string | null;
  caseId: string | null;
  turnId: string | null;
  requestKey: string | null;
  /** Display text only (≤ 80 characters). Prompt- or model-derived: render as text. */
  title: string;
  /** The latest engine step label ("Searching logs"), display text. */
  label: string | null;
  lookups: number;
  status: ChatActivityStatus;
  /** A question waiting on the analyst that they have already looked at. */
  seen?: boolean;
  startedAt: number;
  /** `local`: this tab's runner; `peer`: another tab; `server`: the backend. */
  source: 'local' | 'peer' | 'server';
}

export interface ChatActivitySnapshot {
  entries: readonly ChatActivity[];
  /** `ChatAgentConfig.animated_brand` as last seen (`/chat/context`); default on. */
  animatedBrand: boolean;
}

export interface ChatActivitySettled {
  activity: ChatActivity;
  outcome: ChatActivityOutcome;
  /** The analyst had this chat on screen (no toast, no unread mark). */
  viewed: boolean;
}

/** Messages for other tabs (`ActivityEffects` sends them on a BroadcastChannel). */
export type ChatActivityMessage =
  | { t: 'put'; a: ChatActivity }
  | { t: 'drop' | 'seen'; s: string }
  | { t: 'clear' };

type Listener = () => void;

let snapshot: ChatActivitySnapshot = { entries: [], animatedBrand: true };
const listeners = new Set<Listener>();
const settledListeners = new Set<(event: ChatActivitySettled) => void>();
const clearListeners = new Set<Listener>();
const viewing = new Map<string, number>();
let sink: ((message: ChatActivityMessage) => void) | null = null;

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

function commit(entries: readonly ChatActivity[], animatedBrand = snapshot.animatedBrand): void {
  snapshot = { entries, animatedBrand };
  for (const listener of Array.from(listeners)) listener();
}

const find = (scope: string) => snapshot.entries.find((entry) => entry.scope === scope);

function replace(entry: ChatActivity | null, scope: string): void {
  const rest = snapshot.entries.filter((item) => item.scope !== scope);
  commit(entry ? [entry, ...rest] : rest);
}

function send(message: ChatActivityMessage, local: boolean): void {
  if (local) sink?.(message);
}

export function getChatActivity(): ChatActivitySnapshot {
  return snapshot;
}

export function subscribeChatActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `settled` fires once per finished turn; `clear` on sign-out (the runner aborts). */
export function onChatActivity(event: 'settled', listener: (event: ChatActivitySettled) => void): () => void;
export function onChatActivity(event: 'clear', listener: Listener): () => void;
export function onChatActivity(event: 'settled' | 'clear', listener: Listener | ((event: ChatActivitySettled) => void)): () => void {
  const set = (event === 'clear' ? clearListeners : settledListeners) as Set<unknown>;
  set.add(listener);
  return () => set.delete(listener);
}

/** Where this tab's own changes go (the BroadcastChannel); `null` detaches. */
export function setChatActivitySink(next: ((message: ChatActivityMessage) => void) | null): void {
  sink = next;
}

export function setAnimatedBrand(value: boolean): void {
  if (snapshot.animatedBrand !== value) commit(snapshot.entries, value);
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

/**
 * A turn finished. On screen it simply ends; elsewhere it becomes `unread` (an answer)
 * or `failed`, and a clarifying question stays as `needs_input` until it is answered.
 */
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
  } else if (message.t === 'drop') {
    dropChatActivity(message.s, false);
  } else if (message.t === 'seen') {
    markChatActivitySeen(message.s, false);
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

/** Sign-out or another user: forget everything and stop this tab's turns. */
export function clearChatActivity(local = true): void {
  if (snapshot.entries.length) commit([]);
  for (const listener of Array.from(clearListeners)) listener();
  send({ t: 'clear' }, local);
}

const getServerSnapshot = () => snapshot;

export function useChatActivity(): ChatActivitySnapshot {
  return React.useSyncExternalStore(subscribeChatActivity, getChatActivity, getServerSnapshot);
}

/** One scope's entry (`case:<id>`, `conv:<id>` …), or null. */
export function useScopeActivity(scope: string | null | undefined): ChatActivity | null {
  const { entries } = useChatActivity();
  return (scope && entries.find((entry) => entry.scope === scope)) || null;
}
