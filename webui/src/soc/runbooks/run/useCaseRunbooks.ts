/**
 * The runbooks on one case (Round 14, SPEC §4.10.7, §4.10.11): `GET
 * /api/cases/{case_id}/runbooks` held for the case detail, so the Runbook tab, the
 * Overview's Next step card, the facts rail and the close dialog read the SAME runs.
 *
 * - Read when the case opens (and again on `refresh`); a slow answer for an earlier case
 *   never replaces the newer case's runs.
 * - A write's answer (`RunbookRunUpdate`, `RunbookAttachResult`) is merged at once.
 * - A `case.runbook` frame for this case with a newer revision reads the runs again; while
 *   no stream is open, a run whose lookups are still being collected is read again a few
 *   times so their results appear without a manual refresh.
 *
 * Each step's evidence arrives already redacted for this viewer (§4.10.8). Values are
 * plain data (#9); nothing here changes the case (#3).
 */
import * as React from 'react';

import { getCaseRunbooks } from '@/lib/api-runbooks';
import type {
  CaseRunbooks,
  RunbookAttachResult,
  RunbookRun,
  RunbookRunUpdate,
} from '@/lib/types-runbooks';

import { useRunbookFrames } from './live';
import { lookupResultOf, stepStateOf } from './model';

export interface CaseRunbooksState {
  /** The case's runs, or null until the first read (or after a failed first read). */
  data: CaseRunbooks | null;
  loading: boolean;
  /** The last read's failure (the runs already shown stay). */
  error: unknown;
  /** Read again; resolves when the read settles. */
  refresh: () => Promise<void>;
  /** Merge the answer of a write to one run. */
  applyUpdate: (update: RunbookRunUpdate) => void;
  /** Merge the answer of Start runbook. */
  applyAttach: (result: RunbookAttachResult) => void;
  /** True while the page's runbook stream is open. */
  live: boolean;
}

/** How long after attachment a run's background lookups are still expected (ms). */
const LOOKUP_WINDOW_MS = 120_000;
/** How often the runs are read again while lookups are expected and no stream is open. */
const LOOKUP_POLL_MS = 5_000;
/** At most this many such reads per case view. */
const LOOKUP_POLL_MAX = 12;
/** Frames for this case are gathered this long before one read. */
const FRAME_DEBOUNCE_MS = 250;

/** True when an active run attached recently still waits for an automatic lookup. */
export function awaitingLookups(data: CaseRunbooks | null, now: number = Date.now()): boolean {
  for (const run of data?.runs ?? []) {
    if (run.status !== 'active') continue;
    const attached = Date.parse(run.attached_at || '');
    if (!Number.isFinite(attached) || now - attached > LOOKUP_WINDOW_MS) continue;
    for (const step of run.snapshot.steps) {
      if (step.kind !== 'lookup' || step.lookup?.run !== 'on_attach') continue;
      if (!lookupResultOf(stepStateOf(run, step.id))) return true;
    }
  }
  return false;
}

/** `data` with `run` (from a write's answer) in place of the run of the same id. */
export function mergeRun(data: CaseRunbooks, run: RunbookRun, progress: RunbookRunUpdate['progress'] | null, revision: number): CaseRunbooks {
  const exists = data.runs.some((r) => r.run_id === run.run_id);
  const runs = exists ? data.runs.map((r) => (r.run_id === run.run_id ? run : r)) : [...data.runs, run];
  return {
    ...data,
    runs,
    progress: progress ? { ...data.progress, [run.run_id]: progress } : data.progress,
    revision: Math.max(data.revision ?? 0, revision ?? 0),
  };
}

export function useCaseRunbooks(caseId: string | null | undefined, opts: { enabled?: boolean } = {}): CaseRunbooksState {
  const enabled = opts.enabled !== false && Boolean(caseId);
  const id = caseId || '';
  const [data, setData] = React.useState<CaseRunbooks | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);

  // The newest case asked for: a slow read for an earlier case is dropped.
  const activeRef = React.useRef(id);
  activeRef.current = id;
  const dataRef = React.useRef<CaseRunbooks | null>(null);
  dataRef.current = data;
  const seqRef = React.useRef(0);

  const refresh = React.useCallback(async () => {
    if (!enabled || !id) return;
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const next = await getCaseRunbooks(id);
      if (activeRef.current !== id || seq !== seqRef.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (activeRef.current !== id || seq !== seqRef.current) return;
      setError(err);
    } finally {
      if (activeRef.current === id && seq === seqRef.current) setLoading(false);
    }
  }, [enabled, id]);

  React.useEffect(() => {
    setData(null);
    setError(null);
    if (!enabled) {
      setLoading(false);
      return;
    }
    void refresh();
  }, [enabled, id, refresh]);

  const applyUpdate = React.useCallback(
    (update: RunbookRunUpdate) => {
      if (!update?.run || update.run.case_id !== activeRef.current) return;
      setData((prev) => (prev ? mergeRun(prev, update.run, update.progress, update.revision) : prev));
    },
    [],
  );

  const applyAttach = React.useCallback(
    (result: RunbookAttachResult) => {
      const run = result?.run;
      if (!run || run.case_id !== activeRef.current) {
        void refresh();
        return;
      }
      setData((prev) => (prev ? mergeRun(prev, run, result.progress, result.revision) : prev));
    },
    [refresh],
  );

  // Live: a frame for this case with a revision newer than the one shown reads again.
  const frameTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (frameTimer.current) clearTimeout(frameTimer.current);
    },
    [],
  );
  const { live } = useRunbookFrames((frame) => {
    if (frame.case_id !== activeRef.current) return;
    const shown = dataRef.current?.revision ?? -1;
    if (frame.revision <= shown) return;
    if (frameTimer.current) clearTimeout(frameTimer.current);
    frameTimer.current = setTimeout(() => {
      frameTimer.current = null;
      void refresh();
    }, FRAME_DEBOUNCE_MS);
  }, enabled);

  // Without a stream: read again while background lookups are being collected.
  const pollsRef = React.useRef(0);
  React.useEffect(() => {
    pollsRef.current = 0;
  }, [id]);
  React.useEffect(() => {
    if (!enabled || live || loading || !awaitingLookups(data)) return undefined;
    if (pollsRef.current >= LOOKUP_POLL_MAX) return undefined;
    const timer = setTimeout(() => {
      pollsRef.current += 1;
      void refresh();
    }, LOOKUP_POLL_MS);
    return () => clearTimeout(timer);
  }, [enabled, live, loading, data, refresh]);

  return { data, loading, error, refresh, applyUpdate, applyAttach, live };
}
