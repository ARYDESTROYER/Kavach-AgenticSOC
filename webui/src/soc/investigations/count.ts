/**
 * How many cases the AI investigates now: the navigation's Case Manager count (Round 16
 * SPEC §3.1, S8). This CORE is on the first-paint graph, so it holds only the number and
 * its subscription and imports React only. The investigation store (`store.ts`, a lazy
 * chunk) writes it; the hook loads that store after first paint for a viewer who may read
 * cases, the way the shell loads its chat activity observer. A chunk that fails to load
 * costs only the count, never the navigation.
 */
import * as React from 'react';

let count = 0;
const listeners = new Set<() => void>();

/** The store's one writer. */
export function setAiCaseCount(next: number): void {
  if (next === count) return;
  count = next;
  for (const listener of [...listeners]) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * The count for the navigation; 0 (and no store, no read, no stream topic) unless
 * `enabled`. While enabled, it holds the investigation store, so the store stays fed.
 */
export function useAiCaseCount(enabled: boolean): number {
  React.useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    let release: (() => void) | undefined;
    import('./store').then(
      (store) => {
        if (alive) release = store.holdInvestigations();
      },
      () => undefined,
    );
    return () => {
      alive = false;
      release?.();
    };
  }, [enabled]);
  const n = React.useSyncExternalStore(subscribe, () => count, () => 0);
  return enabled ? n : 0;
}
