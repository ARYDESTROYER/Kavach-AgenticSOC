/**
 * useTurnAnnouncer — the chat's spoken progress, through the shell's ONE live region
 * (`useAnnouncer`; chat revamp SPEC §10.9). The transcript itself is `role="log"`
 * without `aria-live`, so nothing else in the chat speaks.
 *
 *   turn starts      → "Working"
 *   lookups finish   → "Searched logs, 3 lookups" (at most one per 2 s, always the
 *                      latest). Only an operator's `bounded` limits mode has a lookup
 *                      limit to name ("3 of up to 10 lookups"); chat is unlimited by
 *                      default (Round 12 D1), so callers pass `announcedLookupBound(ctx)`
 *                      and a count past the bound never claims one.
 *   turn settles     → "Answer ready" | "Needs your input" (a clarify question,
 *                      Round 12 D10) | "Stopped" | "Error: <message>"
 */
import * as React from 'react';

import type { ChatContextInfo } from '@/lib/types';
import { useAnnouncer } from '@/soc/components/announcer';
import type { ChatAssistantItem, ChatEngine } from '../useChatEngine';

/** What a settled clarify question announces (SPEC D10). */
export const NEEDS_INPUT_ANNOUNCEMENT = 'Needs your input';

/** Minimum gap between two progress announcements. */
export const PROGRESS_ANNOUNCE_MS = 2000;

/**
 * The lookup limit worth naming: the configured `max_tool_calls` in `bounded` mode only.
 * The backend reports the knob even in `unlimited` mode, where it limits nothing.
 */
export function announcedLookupBound(
  context: (Pick<ChatContextInfo, 'limits_mode'> & { bounds?: { max_tool_calls?: number | null } | null }) | null | undefined,
): number | null {
  if (context?.limits_mode !== 'bounded') return null;
  const bound = context.bounds?.max_tool_calls;
  return typeof bound === 'number' && Number.isFinite(bound) && bound > 0 ? bound : null;
}

/** "Searched logs, 3 lookups" / "…, 3 of up to 10 lookups" (a bound is named only while it holds). */
export function progressAnnouncement(label: string, count: number, maxLookups?: number | null): string {
  const bounded = typeof maxLookups === 'number' && maxLookups > 0 && count <= maxLookups;
  const of = bounded ? ` of up to ${maxLookups}` : '';
  return `${label || 'Lookup finished'}, ${count}${of} ${count === 1 && !of ? 'lookup' : 'lookups'}`;
}

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
      else if (settled?.status === 'done' && settled.response?.clarify) announce(NEEDS_INPUT_ANNOUNCEMENT);
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
    pendingRef.current = progressAnnouncement(lastLabel, finishedCount, maxLookups);
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
