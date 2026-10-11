/**
 * Chat activity store: the app-level "agent is working" state (Round 12, SPEC D13).
 *
 * A tiny external store read through `useSyncExternalStore`. This CORE is on the
 * first-paint graph (the navigation glyph, the brand ring, the mobile menu badge and
 * the shell monitor read it), so it holds only the snapshot, its subscription and
 * sign-out, and imports React only. Every writer lives in `activity.ts`, which only the
 * lazy chunks import (the turn runner, the chat views, `ActivityEffects`).
 *
 * Keys (`scope`): `conv:<conversation id>`, `draft:<request key>` (a new thread before
 * `turn.start` names it), `case:<case id>`, `turn:<turn id>` (a server turn with neither).
 *
 * Memory only, never storage: titles are prompt-derived (#9 untrusted text, rendered as
 * text everywhere). Cleared on sign-out and on a change of user.
 */
import * as React from 'react';

export type ChatActivityStatus = 'running' | 'needs_input' | 'unread' | 'failed';

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

/** Messages for other tabs (`ActivityEffects` sends them on a BroadcastChannel). */
export type ChatActivityMessage =
  | { t: 'put'; a: ChatActivity }
  | { t: 'drop' | 'seen'; s: string }
  | { t: 'clear' };

type Listener = () => void;

/** A per-browser mirror of the org's brand-ring switch, so a reload honours "off" at once. */
export const BRAND_KEY = 'soc.chat.animatedBrand';
function readBrand(): boolean {
  try {
    return window.localStorage.getItem(BRAND_KEY) !== '0';
  } catch {
    return true;
  }
}

let snapshot: ChatActivitySnapshot = { entries: [], animatedBrand: typeof window === 'undefined' || readBrand() };
const listeners = new Set<Listener>();
const clearListeners = new Set<Listener>();
let sink: ((message: ChatActivityMessage) => void) | null = null;

export function getChatActivity(): ChatActivitySnapshot {
  return snapshot;
}

export function subscribeChatActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Replace the snapshot (the writers in `activity.ts` only). */
export function writeChatActivity(entries: readonly ChatActivity[], animatedBrand = snapshot.animatedBrand): void {
  snapshot = { entries, animatedBrand };
  for (const listener of Array.from(listeners)) listener();
}

/** Where this tab's own changes go (the BroadcastChannel); `null` detaches. */
export function setChatActivitySink(next: ((message: ChatActivityMessage) => void) | null): void {
  sink = next;
}

/** Send one of this tab's own changes to the other tabs. */
export function sendChatActivity(message: ChatActivityMessage): void {
  sink?.(message);
}

/** Sign-out: the turn runner stops reading every turn. */
export function onChatActivityClear(listener: Listener): () => void {
  clearListeners.add(listener);
  return () => clearListeners.delete(listener);
}

/** Sign-out or another user: forget everything and stop this tab's turns. */
export function clearChatActivity(local = true): void {
  if (snapshot.entries.length) writeChatActivity([]);
  for (const listener of Array.from(clearListeners)) listener();
  if (local) sendChatActivity({ t: 'clear' });
}

export function useChatActivity(): ChatActivitySnapshot {
  return React.useSyncExternalStore(subscribeChatActivity, getChatActivity, getChatActivity);
}
