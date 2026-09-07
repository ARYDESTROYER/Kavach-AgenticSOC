/**
 * HealthWatch — the shell's Agent-health reader, kept OFF the first-paint graph.
 *
 * It renders nothing. It exists so the shell can own the health signal (one reader, one
 * fixed window, available from every route) without dragging the diagnostics state module
 * onto the eager entry chunk: `AppShell` is eager, so anything it imports statically is,
 * and the entry budget is a hard gate (`bundle-first-paint.test.ts`). Agent health is not
 * first-paint content — nothing on the landing frame depends on it — so it loads after,
 * through the same dynamic-import pattern the route-motion layer already uses.
 *
 * `onChange` fires ONLY when the degradation ID SET actually changes, which matters for
 * two different reasons: it keeps the shell from re-rendering on every poll that returns
 * the same answer, and it means the overwhelmingly common case — a healthy deployment, or
 * one whose api client does not expose the endpoints at all — performs no state update at
 * all after mount.
 */
import * as React from 'react';

import {
  healthDegradations,
  useHealthDiagnosticsData,
  type HealthDegradation,
} from './health-diagnostics-state';

export interface HealthWatchProps {
  /** The window the two health signals are read over. */
  windowHours: number;
  /** Called with the new list whenever the degradation ID set changes. */
  onChange: (degradations: HealthDegradation[]) => void;
}

export function HealthWatch({ windowHours, onChange }: HealthWatchProps) {
  const { health, autoClose } = useHealthDiagnosticsData(windowHours);
  const degradations = React.useMemo(
    () => healthDegradations(health, autoClose),
    [health, autoClose],
  );

  // The ID set, not the array identity: the loader hands back a fresh array on every poll.
  const key = degradations.map((signal) => signal.id).join('|');
  const reportedRef = React.useRef('');
  // Read through a ref so the effect depends on the KEY alone; depending on the array too
  // would re-run it on every poll and defeat the point of comparing keys.
  const latestRef = React.useRef(degradations);
  latestRef.current = degradations;

  React.useEffect(() => {
    if (key === reportedRef.current) return;
    reportedRef.current = key;
    onChange(latestRef.current);
  }, [key, onChange]);

  return null;
}

export default HealthWatch;
