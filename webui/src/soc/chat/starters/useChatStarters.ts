/**
 * useChatStarters — the client side of the Round 13 starters (SPEC-chat §3.10).
 *
 * `GET /api/chat/starters` is cached per caller for 60 s on the server; the client
 * mirrors that with a small module cache keyed by principal + surface + conversation +
 * case (the `useChatContext` pattern): remounting the start stack, or opening a new chat
 * inside the window, costs no request. Entries are shared across mounts ONLY under a
 * known principal; without one they stay private to the hook instance, and seeing a
 * different principal drops every entry (and every locally hidden card), so one
 * viewer's suggestions never reach the next viewer in the same tab.
 *
 * Fetches happen when the hook is enabled for a key (the stack mounts, a new chat or
 * another thread or case opens), every 120 s while `poll` is on and the page is
 * visible (the interval stops while the page is hidden), and on window focus once the
 * result's `expires_at` has passed. Every request aborts on unmount and on a key
 * change. `enabled: false` makes no request at all (the viewer switched suggestions
 * off, or the surface does not apply).
 *
 * Never reorder under the analyst: while {@link ChatStartersController.setHeld} is on
 * (the pointer is over the card grid or focus is inside it), a fresh result for the
 * same key is held and applied when it turns off.
 *
 * Also here: the per-session "Hide for a day" set (the client hides the card at once
 * and keeps it hidden across remounts; its `dismissed` event, which hides the family
 * on the server for 24 hours, waits until the toast closes without Undo), and
 * {@link useStarterViewed}, which posts the `viewed` event once per start stack or
 * opened thread (§3.6, §3.10).
 *
 * A waiting dismissal belongs to the viewer who hid the card and never outlives that
 * viewer: it records its principal and is dropped, never posted, when the principal
 * changes, when this user signs out here or in another tab (the chat activity `clear`
 * signal), or when its post is refused (a 401 is never retried). The start screen
 * posts its own waiting dismissals when it unmounts, while the viewer's session is
 * still the one that hid them.
 */
import * as React from 'react';

import type { ChatStartersInfo, StarterSurface } from '@/lib/types';
import { onChatActivity } from '../../chat-activity/activity';
import { getChatStarters, postChatStarterEvent } from '../chat-api';

/** Mirrors the server's per-caller cache window (`CACHE_TTL_S`). */
export const STARTERS_CACHE_TTL_MS = 60_000;
/** The refresh interval while a start stack is mounted and visible (§3.10). */
export const STARTERS_REFRESH_MS = 120_000;
/** `viewed` is posted after the chat page has been visible this long (or on the first send). */
export const STARTERS_VIEWED_AFTER_MS = 2_000;
/** A locally hidden card stays hidden this long (the server's `DISMISS_FOR`). */
export const STARTER_HIDE_MS = 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 16;
const HIDDEN_LIMIT = 64;

interface CacheEntry {
  at: number;
  info: ChatStartersInfo;
}

const cache = new Map<string, CacheEntry>();
const CARD_HEIGHTS_LIMIT = 16;
/** principal + width class → the start cards' heights last measured, slot by slot. */
const cardHeights = new Map<string, readonly number[]>();
/** The last known principal any instance rendered with; a change drops the cache. */
let lastPrincipal: string | null = null;

/* -------------------------------------------------------------------------- */
/* Locally hidden cards ("Hide for a day").                                    */
/* -------------------------------------------------------------------------- */

/** One hide or Undo, in order (the start screen replays them to keep slot identity). */
export interface StarterHideEvent {
  key: string;
  type: 'hide' | 'restore';
}

/** What the start screen reads: the keys hidden now and the history that led there. */
export interface HiddenStarters {
  keys: ReadonlySet<string>;
  log: readonly StarterHideEvent[];
}

/**
 * A hidden card's `dismissed` event waits until its "Hidden for a day" toast closes
 * without Undo (sonner's `onAutoClose` / `onDismiss`), so Undo never leaves the server
 * hiding a card the analyst brought back. This bounds the wait when neither callback
 * comes (no toaster mounted, or every toast dismissed by code).
 */
export const DISMISS_FALLBACK_MS = 60_000;
const HIDE_LOG_LIMIT = 128;

/** key → when it was hidden (ms). */
const hidden = new Map<string, number>();
let hideLog: StarterHideEvent[] = [];
const hiddenListeners = new Set<() => void>();
let hiddenSnapshot: HiddenStarters = { keys: new Set(), log: [] };

interface PendingDismissal {
  token: number;
  /** The opaque server key the `dismissed` event carries. */
  starterKey: string;
  /** The viewer who hid the card (null: auth off); only that viewer's session posts it. */
  principal: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}
/** local hide key → its dismissal, not posted yet. */
const pendingDismissals = new Map<string, PendingDismissal>();
let dismissalToken = 0;
let pagehideBound = false;

function publishHidden(): void {
  hiddenSnapshot = { keys: new Set(hidden.keys()), log: hideLog.slice() };
  for (const listener of hiddenListeners) listener();
}

function pruneHidden(now: number): boolean {
  let changed = false;
  for (const [key, at] of hidden) {
    if (now - at >= STARTER_HIDE_MS) {
      hidden.delete(key);
      hideLog = hideLog.filter((event) => event.key !== key);
      changed = true;
    }
  }
  return changed;
}

function appendHideEvent(event: StarterHideEvent): void {
  hideLog.push(event);
  if (hideLog.length > HIDE_LOG_LIMIT) hideLog = hideLog.slice(hideLog.length - HIDE_LOG_LIMIT);
}

function dropPendingDismissals(): void {
  for (const pending of pendingDismissals.values()) if (pending.timer !== null) clearTimeout(pending.timer);
  pendingDismissals.clear();
}

/** Post every dismissal still waiting (the page is going away: its toasts go too). */
export function flushStarterDismissals(): void {
  for (const key of Array.from(pendingDismissals.keys())) commitStarterDismissal(key);
}

function bindPagehide(): void {
  if (pagehideBound || typeof window === 'undefined') return;
  pagehideBound = true;
  window.addEventListener('pagehide', flushStarterDismissals);
}

/**
 * Hide a card at once. With its opaque server key, its `dismissed` event is scheduled
 * (see {@link commitStarterDismissal}); the returned token names this hide, so a late
 * callback from an earlier toast never commits or cancels a later one. `principal` is
 * the viewer the start screen renders for (the last known principal when omitted): the
 * dismissal is posted only while that viewer is still the one signed in here.
 */
export function hideStarterLocally(key: string, starterKey?: string | null, principal?: string | null): number {
  // The viewer hiding the card is the current one (another viewer's hides go first).
  if (typeof principal === 'string' && principal) notePrincipal(principal);
  hidden.delete(key);
  hidden.set(key, Date.now());
  while (hidden.size > HIDDEN_LIMIT) {
    const oldest = hidden.keys().next().value;
    if (oldest === undefined) break;
    hidden.delete(oldest);
    hideLog = hideLog.filter((event) => event.key !== oldest);
  }
  pruneHidden(Date.now());
  appendHideEvent({ key, type: 'hide' });
  const previous = pendingDismissals.get(key);
  if (previous?.timer != null) clearTimeout(previous.timer);
  pendingDismissals.delete(key);
  dismissalToken += 1;
  const token = dismissalToken;
  if (starterKey) {
    const timer = setTimeout(() => commitStarterDismissal(key, token), DISMISS_FALLBACK_MS);
    pendingDismissals.set(key, { token, starterKey, principal: lastPrincipal, timer });
    bindPagehide();
  }
  publishHidden();
  return token;
}

/**
 * Post a hidden card's `dismissed` event (its toast closed without Undo): the server
 * hides the family for 24 hours. Cached answers still list the card, so the next read
 * asks the server again. A token from an older hide of the same card does nothing, and
 * a dismissal recorded for another viewer than the current one is dropped unposted
 * (it must never hide a family in someone else's suggestions).
 */
export function commitStarterDismissal(key: string, token?: number): void {
  const pending = pendingDismissals.get(key);
  if (!pending || (token !== undefined && pending.token !== token)) return;
  if (pending.timer !== null) clearTimeout(pending.timer);
  pendingDismissals.delete(key);
  if (!hidden.has(key) || pending.principal !== lastPrincipal) return;
  for (const entry of cache.values()) entry.at = 0;
  void postChatStarterEvent({ type: 'dismissed', surface: 'home', keys: [pending.starterKey] }).catch(() => {
    // Presentation state only: the card is already hidden here. A refused post (a 401
    // after a sign-out, say) is dropped, never retried under a later session.
  });
}

/**
 * Undo: show the card again locally and cancel its waiting dismissal, so nothing is
 * posted and the server never hides it. A token from an older hide does nothing.
 */
export function restoreStarterLocally(key: string, token?: number): void {
  const pending = pendingDismissals.get(key);
  if (token !== undefined && pending && pending.token !== token) return;
  if (pending) {
    if (pending.timer !== null) clearTimeout(pending.timer);
    pendingDismissals.delete(key);
  }
  if (!hidden.delete(key)) return;
  appendHideEvent({ key, type: 'restore' });
  publishHidden();
}

/**
 * Whether a hidden card's dismissal is still waiting for its toast (with a token: that
 * very hide, not a later one of the same card). The keyboard Undo asks it.
 */
export function pendingStarterDismissal(key: string, token?: number): boolean {
  const pending = pendingDismissals.get(key);
  return !!pending && (token === undefined || pending.token === token);
}

function subscribeHidden(listener: () => void): () => void {
  hiddenListeners.add(listener);
  return () => hiddenListeners.delete(listener);
}

function hiddenNow(): HiddenStarters {
  if (pruneHidden(Date.now())) hiddenSnapshot = { keys: new Set(hidden.keys()), log: hideLog.slice() };
  return hiddenSnapshot;
}

function hiddenKeysNow(): ReadonlySet<string> {
  return hiddenNow().keys;
}

/** The keys of the cards this viewer hid in this session (and under a day ago). */
export function useHiddenStarterKeys(): ReadonlySet<string> {
  return React.useSyncExternalStore(subscribeHidden, hiddenKeysNow, hiddenKeysNow);
}

/** The hidden keys plus the hide and Undo history (for slot identity). */
export function useHiddenStarters(): HiddenStarters {
  return React.useSyncExternalStore(subscribeHidden, hiddenNow, hiddenNow);
}

function clearHidden(): void {
  dropPendingDismissals();
  if (hidden.size || hideLog.length) {
    hidden.clear();
    hideLog = [];
    publishHidden();
  }
}

/* -------------------------------------------------------------------------- */
/* The response cache.                                                         */
/* -------------------------------------------------------------------------- */

/** Test hook: forget every cached answer and every locally hidden card. */
export function clearChatStartersCache(): void {
  cache.clear();
  cardHeights.clear();
  lastPrincipal = null;
  clearHidden();
}

// A sign-out (here or in this user's other tabs) or another user: the previous viewer's
// suggestions, hides and waiting dismissals leave memory, and nothing waiting is posted
// under whoever signs in next.
onChatActivity('clear', clearChatStartersCache);

/**
 * Record the principal this render runs as; a different known principal clears the
 * cache and the hidden set (the previous viewer's suggestions leave memory).
 */
function notePrincipal(principal: string | null): void {
  if (!principal || principal === lastPrincipal) return;
  if (lastPrincipal !== null) {
    cache.clear();
    cardHeights.clear();
    // Another viewer: the previous one's hides (and any dismissal still waiting) go.
    clearHidden();
  }
  lastPrincipal = principal;
}

/* -------------------------------------------------------------------------- */
/* Measured card heights (the next skeleton's height).                         */
/* -------------------------------------------------------------------------- */

function cardHeightsKey(principal: string | null, widthClass: string): string {
  return JSON.stringify([principal ?? '', widthClass]);
}

/**
 * Record the start cards' measured heights (CSS px, slot order) for this principal and
 * width class, so the next skeleton there takes the loaded height and the grid does
 * not grow when the cards arrive (Round 13 polish). Numbers only; dropped with the cache.
 */
export function rememberStarterCardHeights(principal: string | null, widthClass: string, heights: readonly number[]): void {
  if (!heights.length || heights.some((h) => !Number.isFinite(h) || h <= 0)) return;
  const key = cardHeightsKey(principal, widthClass);
  const previous = cardHeights.get(key);
  if (previous && previous.length === heights.length && previous.every((h, i) => h === heights[i])) return;
  cardHeights.delete(key);
  cardHeights.set(key, [...heights]);
  while (cardHeights.size > CARD_HEIGHTS_LIMIT) {
    const oldest = cardHeights.keys().next().value;
    if (oldest === undefined) break;
    cardHeights.delete(oldest);
  }
}

/** The card heights last measured for this principal and width class, if any. */
export function starterCardHeights(principal: string | null, widthClass: string): readonly number[] | null {
  return cardHeights.get(cardHeightsKey(principal, widthClass)) ?? null;
}

function remember(key: string, info: ChatStartersInfo, at: number): void {
  cache.delete(key);
  cache.set(key, { at, info });
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function freshEntry(key: string, now: number): CacheEntry | null {
  const entry = cache.get(key);
  return entry && now - entry.at < STARTERS_CACHE_TTL_MS ? entry : null;
}

/** Whether `expires_at` (ISO 8601) has passed; an unreadable stamp counts as expired. */
export function startersExpired(info: Pick<ChatStartersInfo, 'expires_at'> | null, now = Date.now()): boolean {
  if (!info) return false;
  const at = Date.parse(info.expires_at);
  return !Number.isFinite(at) || now >= at;
}

/* -------------------------------------------------------------------------- */
/* The hook.                                                                   */
/* -------------------------------------------------------------------------- */

export interface UseChatStartersArgs {
  surface: StarterSurface;
  conversationId?: string | null;
  caseId?: string | null;
  /** The signed-in principal (`useAuth().username`); null: nothing shared across mounts. */
  principal?: string | null;
  /** false: no request at all (switched off, or the surface does not apply now). */
  enabled?: boolean;
  /** Re-read every 120 s while the page is visible (the mounted home stack). */
  poll?: boolean;
}

export interface ChatStartersController {
  /** The applied answer for the current key (null while the first read runs or fails). */
  info: ChatStartersInfo | null;
  /** The first read for this key is running (nothing to show yet). */
  loading: boolean;
  /** The read failed and nothing is cached for this key. */
  error: string | null;
  /** Read again now (after an error, or on demand). */
  retry: () => void;
  /** Hold fresh results while the analyst points at or focuses the cards; false applies one. */
  setHeld: (held: boolean) => void;
}

interface Applied {
  key: string;
  info: ChatStartersInfo | null;
  error: string | null;
}

export function useChatStarters(args: UseChatStartersArgs): ChatStartersController {
  const { surface, conversationId = null, caseId = null, principal = null, enabled = true, poll = false } = args;
  const instanceId = React.useId();
  const known = typeof principal === 'string' && principal.length > 0;
  const namespace = known ? `principal:${principal}` : `instance:${instanceId}`;
  notePrincipal(known ? principal : null);
  const key = JSON.stringify([namespace, surface, conversationId ?? '', caseId ?? '']);

  // Instance-private entries are unreachable once this instance unmounts: drop them.
  React.useEffect(() => {
    const prefix = JSON.stringify([`instance:${instanceId}`]).slice(0, -1);
    return () => {
      for (const entryKey of Array.from(cache.keys())) if (entryKey.startsWith(`${prefix},`)) cache.delete(entryKey);
    };
  }, [instanceId]);

  const [applied, setApplied] = React.useState<Applied>(() => ({ key, info: cache.get(key)?.info ?? null, error: null }));
  const [request, setRequest] = React.useState<{ n: number; force: boolean }>({ n: 0, force: false });
  const handledRef = React.useRef(0);
  const heldRef = React.useRef(false);
  const pendingRef = React.useRef<{ key: string; info: ChatStartersInfo } | null>(null);

  // Another key never shows the previous key's cards (a thread or case switch).
  let current = applied;
  if (applied.key !== key) {
    current = { key, info: cache.get(key)?.info ?? null, error: null };
    setApplied(current);
  }
  const currentRef = React.useRef(current);
  currentRef.current = current;

  React.useEffect(() => {
    if (!enabled) return undefined;
    const force = request.force && request.n !== handledRef.current;
    handledRef.current = request.n;
    const cached = freshEntry(key, Date.now());
    if (cached && !force) {
      setApplied((prev) => (prev.key === key && prev.info === cached.info && !prev.error ? prev : { key, info: cached.info, error: null }));
      return undefined;
    }
    const controller = new AbortController();
    getChatStarters({ surface, conversationId, caseId }, controller.signal)
      .then((info) => {
        if (controller.signal.aborted) return;
        remember(key, info, Date.now());
        const shown = currentRef.current;
        if (heldRef.current && shown.key === key && shown.info) {
          // Never reorder under the analyst: apply on pointer leave or focus out.
          pendingRef.current = { key, info };
          return;
        }
        pendingRef.current = null;
        setApplied({ key, info, error: null });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // A failed refresh keeps the cards on screen; only an empty view shows the error.
        setApplied((prev) =>
          prev.key === key && prev.info
            ? prev
            : { key, info: null, error: err instanceof Error && err.message ? err.message : 'Suggestions are unavailable.' },
        );
      });
    return () => controller.abort();
    // `request` carries the refresh intent; the key covers surface/conversation/case/principal.
  }, [key, enabled, request, surface, conversationId, caseId]);

  const refresh = React.useCallback(() => setRequest((r) => ({ n: r.n + 1, force: true })), []);

  // Every 120 s while visible; the interval stops while the page is hidden.
  React.useEffect(() => {
    if (!enabled || !poll || typeof document === 'undefined') return undefined;
    let timer: number | null = null;
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const start = () => {
      stop();
      timer = window.setInterval(() => {
        if (document.visibilityState === 'visible') refresh();
      }, STARTERS_REFRESH_MS);
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, poll, key, refresh]);

  // Back on the window: re-read once the answer has expired.
  React.useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;
    const onFocus = () => {
      if (startersExpired(currentRef.current.info)) refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [enabled, key, refresh]);

  const setHeld = React.useCallback((held: boolean) => {
    heldRef.current = held;
    if (held) return;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending && pending.key === currentRef.current.key) setApplied({ key: pending.key, info: pending.info, error: null });
  }, []);

  // Retry shows the loading state again (not the old error) while it reads.
  const retry = React.useCallback(() => {
    setApplied((prev) => (prev.error ? { ...prev, error: null } : prev));
    refresh();
  }, [refresh]);

  const info = enabled ? current.info : null;
  const error = enabled && !current.info ? current.error : null;
  return {
    info,
    loading: enabled && !current.info && !error,
    error,
    retry,
    setHeld,
  };
}

/* -------------------------------------------------------------------------- */
/* The `viewed` event (§3.6, §3.10).                                           */
/* -------------------------------------------------------------------------- */

export interface UseStarterViewedArgs {
  /**
   * One id per start-stack instance (`home:<epoch>`) or opened thread
   * (`thread:<conversation id>`); null: nothing on screen to record.
   */
  target: string | null;
  surface: 'home' | 'thread';
  /** false: post nothing (the viewer switched suggestions off). */
  enabled: boolean;
  /** false while the cards are still loading: a due event waits for them. */
  ready: boolean;
  /** The keys to report, read when the event is posted (home: the cards shown). */
  keys: () => readonly string[];
}

/** How long after its target ended a pending event still counts for a send (ms). */
const FLUSH_GRACE_MS = 1_000;

/**
 * Post `viewed` once per target: after the chat page has been visible for 2 seconds
 * (the clock restarts when the page comes back from hidden) or on the first send,
 * whichever comes first. Returns `flush`, which the host calls when a send starts: it
 * posts the current target's event, or the one whose stack the send just replaced. A
 * home event carries the keys of the cards shown; a thread event carries none.
 * Failures are silent (presentation state only).
 */
export function useStarterViewed({ target, surface, enabled, ready, keys }: UseStarterViewedArgs): () => void {
  const postedRef = React.useRef<string | null>(null);
  const dueRef = React.useRef(false);
  const live = React.useRef({ target, surface, enabled, ready, keys });
  live.current = { target, surface, enabled, ready, keys };
  /** The last target that ended without an event: a send may have replaced it. */
  const endedRef = React.useRef<{ target: string; surface: 'home' | 'thread'; keys: readonly string[]; at: number } | null>(null);

  const send = React.useCallback((t: string, s: 'home' | 'thread', k: readonly string[]) => {
    postedRef.current = t;
    dueRef.current = false;
    void postChatStarterEvent({ type: 'viewed', surface: s, keys: s === 'home' ? [...k] : [] }).catch(() => {
      /* presentation state only: a lost event changes nothing on screen */
    });
  }, []);

  const postCurrent = React.useCallback(() => {
    const now = live.current;
    if (!now.target || !now.enabled || postedRef.current === now.target) return;
    send(now.target, now.surface, now.keys());
  }, [send]);

  // A target that ends unposted is remembered for a moment (the send that replaced it).
  const previousRef = React.useRef<{ target: string | null; surface: 'home' | 'thread'; enabled: boolean }>({
    target,
    surface,
    enabled,
  });
  React.useLayoutEffect(() => {
    const previous = previousRef.current;
    if (previous.target && previous.target !== target && previous.enabled && postedRef.current !== previous.target) {
      endedRef.current = { target: previous.target, surface: previous.surface, keys: [...live.current.keys()], at: Date.now() };
    }
    previousRef.current = { target, surface, enabled };
  });

  React.useEffect(() => {
    dueRef.current = false;
    if (!target || !enabled || typeof document === 'undefined') return undefined;
    let timer: number | null = null;
    const clear = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const arm = () => {
      clear();
      timer = window.setTimeout(() => {
        timer = null;
        if (live.current.ready) postCurrent();
        else dueRef.current = true;
      }, STARTERS_VIEWED_AFTER_MS);
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? arm() : clear());
    if (document.visibilityState === 'visible') arm();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clear();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [target, enabled, postCurrent]);

  React.useEffect(() => {
    if (ready && dueRef.current) postCurrent();
  }, [ready, postCurrent]);

  return React.useCallback(() => {
    const now = live.current;
    if (now.target) {
      postCurrent();
      return;
    }
    const ended = endedRef.current;
    endedRef.current = null;
    if (!ended || !now.enabled || postedRef.current === ended.target || Date.now() - ended.at > FLUSH_GRACE_MS) return;
    send(ended.target, ended.surface, ended.keys);
  }, [postCurrent, send]);
}
