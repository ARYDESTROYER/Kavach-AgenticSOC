/**
 * useChatContext — the composer meter / catalogue / starters source (SPEC §8, §10.5).
 *
 * `GET /api/chat/context` is cached per principal for 30 s on the server; the client
 * mirrors that with a small module cache keyed by principal + case + conversation +
 * model, so remounting the chat page (or switching back to a thread) inside the
 * window costs no request. Fresh numbers are fetched:
 *
 * - when the conversation, the model override or the case changes (new key);
 * - after a turn settles (`busy` true → false), because the history estimate,
 *   calibration and today's spend all move — this one bypasses the cache;
 * - on `refresh()` (forced) or `revalidate()` (only when the entry is older than
 *   30 s; the composer calls it on focus).
 *
 * Every request is aborted on unmount and when its key changes; nothing is fetched
 * while `enabled` is false. A failed refresh keeps the last good context (the meter
 * stays useful) and reports `error`. The previous context is also kept while the
 * next key loads, except across a principal or case change, where showing the old
 * catalogue would be wrong.
 */
import * as React from 'react';
import type { ChatContextInfo } from '@/lib/types';
import { getChatContext } from './chat-api';

export interface UseChatContextArgs {
  conversationId: string | null;
  model: string | null;
  caseId?: string | null;
  /** false while the page is not ready to ask (e.g. auth not settled). */
  enabled?: boolean;
  /**
   * The signed-in principal (`useAuth().username`). Part of the cache key so one
   * user's catalogue and spend are never served to the next user in the same tab.
   */
  principal?: string | null;
  /**
   * The engine's `busy` flag. When it falls back to false (a turn settled) the
   * context is re-read, bypassing the cache.
   */
  busy?: boolean;
}

export interface ChatContextController {
  context: ChatContextInfo | null;
  loading: boolean;
  error: string | null;
  /** Re-read now (after a turn settles, the estimate and spend change). */
  refresh: () => void;
  /** Re-read only when the cached entry is older than {@link CHAT_CONTEXT_TTL_MS}. */
  revalidate: () => void;
}

/** Mirrors the server's per-principal cache window (SPEC §8). */
export const CHAT_CONTEXT_TTL_MS = 30_000;
const CACHE_LIMIT = 24;

interface CacheEntry {
  at: number;
  context: ChatContextInfo;
}

const cache = new Map<string, CacheEntry>();

/** Test hook: forget every cached context. */
export function clearChatContextCache(): void {
  cache.clear();
}

function cacheKey(principal: string | null, caseId: string | null, conversationId: string | null, model: string | null) {
  return JSON.stringify([principal ?? '', caseId ?? '', conversationId ?? '', model ?? '']);
}

function remember(key: string, context: ChatContextInfo, at: number) {
  cache.delete(key);
  cache.set(key, { at, context });
  // Oldest first (Map keeps insertion order): drop beyond the bound.
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function freshEntry(key: string, now: number): CacheEntry | null {
  const entry = cache.get(key);
  return entry && now - entry.at < CHAT_CONTEXT_TTL_MS ? entry : null;
}

export function useChatContext(args: UseChatContextArgs): ChatContextController {
  const { conversationId, model, caseId = null, enabled = true, principal = null, busy = false } = args;
  const key = cacheKey(principal, caseId, conversationId, model);
  const scopeKey = JSON.stringify([principal ?? '', caseId ?? '']);

  const [context, setContext] = React.useState<ChatContextInfo | null>(() => cache.get(key)?.context ?? null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // `force` bypasses the cache; `ifStale` re-reads only an entry past its TTL.
  const [request, setRequest] = React.useState<{ n: number; mode: 'force' | 'ifStale' }>({ n: 0, mode: 'ifStale' });
  const scopeRef = React.useRef(scopeKey);
  // The last request number the fetch effect consumed: a forced refresh applies once,
  // not again to a later key change (a thread switch reads the cache as usual).
  const handledRef = React.useRef(0);

  // A different principal or case must never show the previous catalogue or spend.
  if (scopeRef.current !== scopeKey) {
    scopeRef.current = scopeKey;
    const cached = cache.get(key)?.context ?? null;
    if (context !== cached) setContext(cached);
  }

  React.useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return undefined;
    }
    const force = request.mode === 'force' && request.n !== handledRef.current;
    handledRef.current = request.n;
    const cached = freshEntry(key, Date.now());
    if (cached && !force) {
      setContext(cached.context);
      setError(null);
      setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    setLoading(true);
    getChatContext({ conversationId, model, caseId }, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        remember(key, next, Date.now());
        setContext(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error && err.message ? err.message : 'The assistant context is unavailable.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // `request` carries the refresh intent; the key covers conversation/model/case/principal.
  }, [key, enabled, request, conversationId, model, caseId]);

  // A settled turn changes history, calibration and spend: re-read past the cache.
  const wasBusy = React.useRef(busy);
  React.useEffect(() => {
    if (wasBusy.current && !busy) setRequest((r) => ({ n: r.n + 1, mode: 'force' }));
    wasBusy.current = busy;
  }, [busy]);

  const refresh = React.useCallback(() => setRequest((r) => ({ n: r.n + 1, mode: 'force' })), []);
  const keyRef = React.useRef(key);
  keyRef.current = key;
  const revalidate = React.useCallback(() => {
    if (freshEntry(keyRef.current, Date.now())) return;
    setRequest((r) => ({ n: r.n + 1, mode: 'ifStale' }));
  }, []);

  return { context, loading, error, refresh, revalidate };
}
