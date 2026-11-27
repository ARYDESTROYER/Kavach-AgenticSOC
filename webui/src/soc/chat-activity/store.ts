/**
 * Chat activity store: the app-level "agent is working" state (Round 12, SPEC D13).
 *
 * A tiny external store read through `useSyncExternalStore`. This CORE is on the
 * first-paint graph (the navigation glyph, the brand ring and the mobile menu badge read
 * it), so it holds only the snapshot and its subscription and imports React only. Every
 * writer lives in `activity.ts`, which only lazy chunks import (the turn runner, the chat
 * views, `ActivityEffects`); the writers also precompute the navigation summaries below,
 * so no wording logic rides the entry chunk.
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
  /**
   * This tab's runner stopped reading the answer while nobody looks at it (it follows
   * the turn through `GET /chat/turns/active` and reads the rest when it ends).
   */
  parked?: boolean;
}

/** One destination's state: the glyph's status and its text ('' when idle). */
export interface ChatActivitySummary {
  /** The most important state, for the glyph. */
  status: ChatActivityStatus | null;
  /** "Chat: 1 answer in progress: <title>" (display text; empty when idle). */
  text: string;
}

export interface ChatActivitySnapshot {
  entries: readonly ChatActivity[];
  /** `ChatAgentConfig.animated_brand` as last seen (`/chat/context`); default on. */
  animatedBrand: boolean;
  /** Workspace chat (the Workspace and Chat items), written by `activity.ts`. */
  workspace: ChatActivitySummary;
  /** Case-scoped chat (the Case Manager item). */
  case: ChatActivitySummary;
  /** Both (the mobile menu button, the brand ring). */
  all: ChatActivitySummary;
}

/** A per-browser mirror of the org's brand-ring switch, so a reload honours "off" at once. */
export const BRAND_KEY = 'soc.chat.animatedBrand';

const IDLE: ChatActivitySummary = { status: null, text: '' };

function readBrand(): boolean {
  try {
    return window.localStorage.getItem(BRAND_KEY) !== '0';
  } catch {
    return true;
  }
}

let snapshot: ChatActivitySnapshot = { entries: [], animatedBrand: readBrand(), workspace: IDLE, case: IDLE, all: IDLE };
const listeners = new Set<() => void>();

export function getChatActivity(): ChatActivitySnapshot {
  return snapshot;
}

export function subscribeChatActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Replace the snapshot (the writers in `activity.ts` only). */
export function writeChatActivity(next: ChatActivitySnapshot): void {
  snapshot = next;
  for (const listener of Array.from(listeners)) listener();
}

/** One live frame as the shell's stream hands it over (`StreamEvent` fits). */
export interface ChatFrame {
  type: string;
  data: unknown;
}

let frameSink: ((frame: ChatFrame) => void) | null = null;

/**
 * The caller's own `chat.turn` frames (topic `chat`, SPEC D13) ride the shell's job
 * stream (`JobMonitor`), so no connection is opened for them. Every frame of that stream
 * comes through here to the lazy `ActivityEffects`, which reads only `chat.turn` and
 * `overflow`; before it loads a frame is dropped (it asks the server when it mounts).
 * Transport only: the payload is untrusted and nothing here renders it (#9).
 */
export function relayChatFrame(frame: ChatFrame): void {
  frameSink?.(frame);
}

/** `ActivityEffects` takes the frames; `null` lets go. */
export function setChatFrameSink(next: ((frame: ChatFrame) => void) | null): void {
  frameSink = next;
}

/**
 * The snapshot, or a slice of it. A selector must return a value that keeps its
 * identity while unchanged (the writers keep each summary object until its status or
 * text changes), so a host re-renders only when what it shows changes, not on every
 * step of a running answer.
 */
export function useChatActivity(): ChatActivitySnapshot;
export function useChatActivity<T>(select: (snapshot: ChatActivitySnapshot) => T): T;
export function useChatActivity<T>(select?: (snapshot: ChatActivitySnapshot) => T): T | ChatActivitySnapshot {
  const get = () => (select ? select(snapshot) : snapshot);
  return React.useSyncExternalStore(subscribeChatActivity, get, get);
}
