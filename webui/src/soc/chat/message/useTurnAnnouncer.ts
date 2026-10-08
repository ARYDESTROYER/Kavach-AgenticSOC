/**
 * useTurnAnnouncer — the chat's spoken progress, through the shell's ONE live region
 * (`useAnnouncer`; chat revamp SPEC §10.9). The transcript itself is `role="log"`
 * without `aria-live`, so nothing else in the chat speaks.
 *
 *   turn starts      → "Working"
 *   lookups finish   → "Searched logs, 3 of up to 10 lookups" (at most one per 2 s,
 *                      always the latest)
 *   turn settles     → "Answer ready" | "Stopped" | "Error: <message>"
 */
import * as React from 'react';

import { useAnnouncer } from '@/soc/components/announcer';
import type { ChatAssistantItem, ChatEngine } from '../useChatEngine';

/** Minimum gap between two progress announcements. */
export const PROGRESS_ANNOUNCE_MS = 2000;

export function useTurnAnnouncer(engine: Pick<ChatEngine, 'items' | 'running'>, maxLookups?: number | null): void {
  const announce = useAnnouncer();
  const previousKeyRef = React.useRef<string | null>(null);
  const timerRef = React.useRef<number | null>(null);
  const pendingRef = React.useRef<string | null>(null);
  const itemsRef = React.useRef(engine.items);
  itemsRef.current = engine.items;

  const clearTimer = React.useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingRef.current = null;
  }, []);

  const runningKey = engine.running?.key ?? null;
  React.useEffect(() => {
    const previous = previousKeyRef.current;
    previousKeyRef.current = runningKey;
    if (previous && previous !== runningKey) {
      clearTimer();
      const settled = itemsRef.current.find(
        (item): item is ChatAssistantItem => item.kind === 'assistant' && item.key === previous,
      );
      if (settled?.status === 'error') announce(`Error: ${settled.failure?.message || 'the assistant could not answer.'}`);
      else if (settled?.response?.notice?.kind === 'cancelled') announce('Stopped');
      else if (settled?.status === 'done') announce('Answer ready');
    }
    if (runningKey && runningKey !== previous) announce('Working');
  }, [announce, clearTimer, runningKey]);

  const steps = engine.running?.live?.steps;
  const finished = React.useMemo(
    () => (steps ?? []).filter((step) => step.kind === 'tool' && step.status !== 'running'),
    [steps],
  );
  const finishedCount = finished.length;
  const lastLabel = finished[finished.length - 1]?.label ?? '';
  React.useEffect(() => {
    if (!runningKey || finishedCount === 0) return;
    const of = typeof maxLookups === 'number' && maxLookups > 0 ? ` of up to ${maxLookups}` : '';
    pendingRef.current = `${lastLabel || 'Lookup finished'}, ${finishedCount}${of} ${finishedCount === 1 && !of ? 'lookup' : 'lookups'}`;
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const message = pendingRef.current;
      pendingRef.current = null;
      if (message) announce(message);
    }, PROGRESS_ANNOUNCE_MS);
  }, [announce, finishedCount, lastLabel, maxLookups, runningKey]);

  React.useEffect(() => clearTimer, [clearTimer]);
}
