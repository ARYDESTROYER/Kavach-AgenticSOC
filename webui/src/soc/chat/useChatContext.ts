/**
 * useChatContext — the composer meter / catalogue / starters source (SPEC §8, §10.5).
 *
 * INTERFACE STUB written by the orchestrator so the workspace shell (WP-I2a) and the
 * composer package (WP-I2b) can build in parallel. WP-I2b owns this file and replaces
 * the body (per-principal caching, refresh on conversation/model change, abort on
 * unmount); the exported signature must stay as declared here.
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
}

export interface ChatContextController {
  context: ChatContextInfo | null;
  loading: boolean;
  error: string | null;
  /** Re-read now (after a turn settles, the estimate and spend change). */
  refresh: () => void;
}

export function useChatContext(args: UseChatContextArgs): ChatContextController {
  const { conversationId, model, caseId = null, enabled = true } = args;
  const [context, setContext] = React.useState<ChatContextInfo | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    setLoading(true);
    getChatContext({ conversationId, model, caseId }, controller.signal)
      .then((ctx) => {
        setContext(ctx);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Context unavailable');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [conversationId, model, caseId, enabled, nonce]);
  const refresh = React.useCallback(() => setNonce((n) => n + 1), []);
  return { context, loading, error, refresh };
}
