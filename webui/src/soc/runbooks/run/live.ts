/**
 * Live runbook progress (Round 14, SPEC §4.10.15): the `case.runbook` frames on the
 * `runbooks` topic, and the queue chips' progress per case.
 *
 * ONE stream for the page. Every surface that wants frames (the Case Manager queue, the
 * open case's Runbook tab) registers here; the first one registered opens the single
 * `runbooks` subscription and fans its frames out to the others, and when it unmounts the
 * next one takes over. So a Case Manager with a case open holds one runbook stream, not
 * two (browsers allow few connections per origin).
 *
 * A frame carries ids, a run's progress and the case document's revision only, never a
 * value from the run (#9); it is a nudge to read again, so the chips are always the
 * progress endpoint's answer (`POST /api/runbooks/progress`, the sum over every run of a
 * case that is not abandoned) and the tab re-reads `GET /api/cases/{id}/runbooks`.
 * Nothing here decides anything about a case (#3).
 */
import * as React from 'react';

import { useEventStream, type StreamEvent } from '@/lib/useEventStream';
import { getRunbookProgress } from '@/lib/api-runbooks';
import type { CaseRunbookFrame, RunbookProgress } from '@/lib/types-runbooks';

/** The SSE channel of a run change. */
export const CASE_RUNBOOK_CHANNEL = 'case.runbook';
/** The topic it is published on (served to holders of runbooks:read and cases:read). */
export const RUNBOOKS_TOPIC = 'runbooks';

const PROGRESS_KEYS: ReadonlyArray<keyof RunbookProgress> = [
  'done',
  'not_applicable',
  'total',
  'required_open',
  'blocked',
  'waiting',
];

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** A progress object with every count present and non-negative, else null. */
export function parseProgress(value: unknown): RunbookProgress | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const out = {} as RunbookProgress;
  for (const key of PROGRESS_KEYS) {
    if (!isCount(v[key])) return null;
    out[key] = Math.trunc(v[key] as number);
  }
  return out;
}

/** A `case.runbook` frame's payload, validated (anything else is ignored). */
export function parseRunbookFrame(data: unknown): CaseRunbookFrame | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.case_id !== 'string' || !d.case_id) return null;
  if (typeof d.run_id !== 'string' || !d.run_id) return null;
  if (!isCount(d.revision)) return null;
  const progress = parseProgress(d.progress);
  if (!progress) return null;
  return { case_id: d.case_id, run_id: d.run_id, progress, revision: Math.trunc(d.revision) };
}

// --------------------------------------------------------------------------- //
// The shared stream
// --------------------------------------------------------------------------- //
type FrameListener = (frame: CaseRunbookFrame) => void;

const listeners = new Set<FrameListener>();
let leaders: symbol[] = [];
const leaderWatchers = new Set<() => void>();
let sharedLive = false;
const liveWatchers = new Set<() => void>();

function notify(watchers: Set<() => void>): void {
  for (const watcher of [...watchers]) watcher();
}

function watchLeaders(onChange: () => void): () => void {
  leaderWatchers.add(onChange);
  return () => leaderWatchers.delete(onChange);
}

function watchLive(onChange: () => void): () => void {
  liveWatchers.add(onChange);
  return () => liveWatchers.delete(onChange);
}

function setSharedLive(next: boolean): void {
  if (sharedLive === next) return;
  sharedLive = next;
  notify(liveWatchers);
}

/** Hand one frame to every registered surface (exported for tests and the leader). */
export function dispatchRunbookFrame(frame: CaseRunbookFrame): void {
  for (const listener of [...listeners]) {
    try {
      listener(frame);
    } catch {
      /* one surface's failure never stops the others */
    }
  }
}

/** Forget every registration (tests only). */
export function resetRunbookLiveForTests(): void {
  listeners.clear();
  leaders = [];
  sharedLive = false;
  notify(leaderWatchers);
  notify(liveWatchers);
}

/**
 * Receive `case.runbook` frames while `enabled`. Returns `live`: true while the page's
 * one runbook stream is open and healthy (a caller may then skip its own polling).
 */
export function useRunbookFrames(onFrame: FrameListener, enabled = true): { live: boolean } {
  const tokenRef = React.useRef<symbol | null>(null);
  if (tokenRef.current === null) tokenRef.current = Symbol('runbook-frames');
  const token = tokenRef.current;
  const onFrameRef = React.useRef(onFrame);
  onFrameRef.current = onFrame;

  React.useEffect(() => {
    if (!enabled) return undefined;
    const listener: FrameListener = (frame) => onFrameRef.current(frame);
    listeners.add(listener);
    leaders = [...leaders, token];
    notify(leaderWatchers);
    return () => {
      listeners.delete(listener);
      const wasLeader = leaders[0] === token;
      leaders = leaders.filter((t) => t !== token);
      if (wasLeader) setSharedLive(false);
      notify(leaderWatchers);
    };
  }, [enabled, token]);

  const isLeader = React.useSyncExternalStore(
    watchLeaders,
    () => enabled && leaders[0] === token,
    () => false,
  );

  const onEvent = React.useCallback((event: StreamEvent) => {
    if (event.type !== CASE_RUNBOOK_CHANNEL) return;
    const frame = parseRunbookFrame(event.data);
    if (frame) dispatchRunbookFrame(frame);
  }, []);

  const { live } = useEventStream([RUNBOOKS_TOPIC], { enabled: isLeader, onEvent });

  React.useEffect(() => {
    if (isLeader) setSharedLive(live);
  }, [isLeader, live]);

  const shared = React.useSyncExternalStore(watchLive, () => sharedLive, () => false);
  return { live: enabled && shared };
}

// --------------------------------------------------------------------------- //
// Queue chips
// --------------------------------------------------------------------------- //
/** How long frames for several cases are gathered before one progress read. */
const FRAME_BATCH_MS = 300;

/**
 * Runbook progress for the cases a queue shows, from `POST /api/runbooks/progress`. A
 * case with no run (or whose runs could not be read) maps to `null`: no chip. Read again
 * when the set of ids or `refreshKey` changes, and for the cases a `case.runbook` frame
 * names. A failed read keeps what was shown (a chip is advisory, never an error).
 *
 * `live` says whether to listen for frames at all: the server serves the `runbooks` topic
 * only with both `runbooks:read` and `cases:read` and silently drops it otherwise, so a
 * viewer without `runbooks:read` would hold a stream that never delivers a frame (and one
 * of the browser's few connections per origin) for nothing.
 */
export function useRunbookProgressMap(
  caseIds: readonly string[],
  opts: { enabled?: boolean; live?: boolean; refreshKey?: unknown } = {},
): Record<string, RunbookProgress | null> {
  const { enabled = true, live = true, refreshKey } = opts;
  const [map, setMap] = React.useState<Record<string, RunbookProgress | null>>({});
  const idsKey = React.useMemo(() => Array.from(new Set(caseIds.filter(Boolean))).sort().join('\n'), [caseIds]);
  const idsRef = React.useRef<Set<string>>(new Set());
  idsRef.current = new Set(idsKey ? idsKey.split('\n') : []);
  const aliveRef = React.useRef(true);
  React.useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const read = React.useCallback(async (ids: string[], signal?: AbortSignal) => {
    if (!ids.length) return;
    try {
      const answer = await getRunbookProgress(ids, signal);
      if (!aliveRef.current || signal?.aborted) return;
      setMap((prev) => {
        const next = { ...prev };
        for (const id of ids) {
          const progress = parseProgress((answer as Record<string, unknown>)[id]);
          next[id] = progress;
        }
        return next;
      });
    } catch {
      /* advisory: keep what is shown */
    }
  }, []);

  React.useEffect(() => {
    if (!enabled || !idsKey) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => void read(idsKey.split('\n'), controller.signal), 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, idsKey, refreshKey, read]);

  const pendingRef = React.useRef<Set<string>>(new Set());
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );
  useRunbookFrames((frame) => {
    if (!idsRef.current.has(frame.case_id)) return;
    pendingRef.current.add(frame.case_id);
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const ids = [...pendingRef.current];
      pendingRef.current.clear();
      void read(ids);
    }, FRAME_BATCH_MS);
  }, enabled && live);

  return map;
}
