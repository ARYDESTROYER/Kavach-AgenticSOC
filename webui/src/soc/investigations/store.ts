/**
 * The AI investigation store (Round 16 SPEC §4.5 WP09, research ai-investigating §4.6):
 * which cases the AI is working on now, keyed by case id, plus the count of runs on new
 * events (`newRuns`) and the investigation slots in use.
 *
 * A small `useSyncExternalStore` store in a lazy chunk: the case pages import it, and the
 * navigation loads it after first paint and keeps its one number, the count of cases the
 * AI investigates now, in the entry-safe `count.ts` (SPEC §3.1). It is fed by:
 *
 * * `GET /api/investigations/active` (the reconcile read) when its first reader mounts,
 *   when the stream (re)opens, on an `overflow` frame, after a run's client expiry, and
 *   every 5 s while a run is known and the stream is not live;
 * * the `case.investigation` frames on the `investigations` topic, through the page's
 *   one stream (`subscribeEvents`), only while a reader that may see cases is mounted;
 * * a `202` from a non-blocking Reinvestigate (`noteReinvestigationStarted`), so the
 *   header chip shows at once.
 *
 * A run shows after a 1 s hold-off (most runs end almost at once, and a busy mark that
 * flashes for a moment helps nobody), unless the server says it began longer ago. Its
 * timestamps are moved into the browser's clock (the route says the server's time), so
 * an elapsed time is right on a machine whose clock is off. A run is dropped at
 * `deadline_at + 60 s` and the route is read again. Frames carry ids, enums, timestamps
 * and counts only (#7); the store renders nothing and decides nothing (#3). Memory only:
 * the last reader to unmount (a sign-out unmounts the shell) clears it.
 */
import * as React from 'react';

import { getActiveInvestigations } from '@/lib/api-investigations';
import type { InvestigationSlots, InvestigationsActive, InvestigationView } from '@/lib/types';
import { subscribeEvents, type StreamEvent } from '@/lib/useEventStream';

import { setAiCaseCount } from './count';

/** No mark for the first second of a run. */
export const HOLD_OFF_MS = 1000;
/** How long a finished run is remembered per case (the route's `recent` window). */
export const FINISHED_TTL_MS = 120_000;
/** A run is dropped this long after its deadline, then the route is read again. */
export const EXPIRY_GRACE_MS = 60_000;
/** The polling fallback while a run is known and the stream is not live. */
export const POLL_MS = 5000;
/** A run this console started (a `202`) shows until the server confirms it, at most this long. */
const LOCAL_TTL_MS = 180_000;

const STATES = ['queued', 'running', 'finished'];
const PHASES = ['queued', 'triage', 'specialist', 'evidence', 'verdict', 'decision'];
const TRIGGERS = ['automatic', 'manual', 'job', 'drain', 'detection'];

/** The last finished run on a case. */
export interface FinishedRun {
  view: InvestigationView;
  /** When this console saw it finish (browser clock, ms). */
  at: number;
  /** This console knew it as queued or running before it ended. */
  active: boolean;
  /** It had been shown as running or queued on this console (past the hold-off). */
  shown: boolean;
}

export interface InvestigationSnapshot {
  /** Queued or running runs past the hold-off, one per case (a running one first). */
  byCase: ReadonlyMap<string, InvestigationView>;
  /** The last finished run per case, for two minutes. */
  finished: ReadonlyMap<string, FinishedRun>;
  /** Runs on new events that have no case yet (past the hold-off; else 0). */
  newRuns: number;
  /** The investigation slots, as of the last reconcile read. */
  slots: InvestigationSlots | null;
  /** The page's stream carries the `investigations` topic now. */
  live: boolean;
  /** The investigation time cap (s), from the last run that said it; null until then. */
  timeCapSeconds: number | null;
}

interface Entry {
  view: InvestigationView;
  seenAt: number;
  showAt: number;
  /** From a `202` this console received, not yet seen on the server. */
  local: boolean;
  /** When this console drops the run and reads the route again (browser clock, ms). */
  expiresAt: number;
}

const runs = new Map<string, Entry>();
const finished = new Map<string, FinishedRun>();
/**
 * Runs this console saw end, by id (bounded). A read sent before a run ended can be
 * answered after its last frame landed: that answer must not bring the run back.
 */
const ended = new Set<string>();
const ENDED_KEEP = 256;
let newRuns = 0;
let newRunsSince = 0;
let slots: InvestigationSlots | null = null;
let timeCap: number | null = null;
let live = false;
/** Server clock minus browser clock (ms), from the route's `generated_at`. */
let skew = 0;
let denied = false;
let lastRead = 0;
let generation = 0;
let reading: Promise<void> | null = null;
let readAgain = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopStream: (() => void) | null = null;
const listeners = new Set<() => void>();
let readers = 0;

const EMPTY: InvestigationSnapshot = {
  byCase: new Map(),
  finished: new Map(),
  newRuns: 0,
  slots: null,
  live: false,
  timeCapSeconds: null,
};
let snapshot: InvestigationSnapshot = EMPTY;

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const oneOf = (value: string | null, list: readonly string[]): boolean => value !== null && list.includes(value);

/** An ISO time moved into the browser's clock. */
function local(iso: string | null): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t - skew).toISOString() : iso;
}

/** A run from the route or a frame, checked (anything else is ignored). */
export function parseRun(raw: unknown): InvestigationView | null {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const runId = str(d.run_id);
  const state = str(d.state);
  const phase = str(d.phase);
  const trigger = str(d.trigger);
  if (!runId || !oneOf(state, STATES) || !oneOf(phase, PHASES) || !oneOf(trigger, TRIGGERS)) return null;
  const view: InvestigationView = {
    run_id: runId,
    case_id: str(d.case_id),
    state: state as InvestigationView['state'],
    phase: phase as InvestigationView['phase'],
    trigger: trigger as InvestigationView['trigger'],
    queued_at: local(str(d.queued_at)) ?? '',
    started_at: local(str(d.started_at)),
    deadline_at: local(str(d.deadline_at)),
    time_cap_seconds: typeof d.time_cap_seconds === 'number' ? d.time_cap_seconds : 0,
    finished_at: local(str(d.finished_at)),
    outcome: str(d.outcome) as InvestigationView['outcome'],
    status_after: str(d.status_after),
    verdict_after: str(d.verdict_after),
  };
  if (view.time_cap_seconds > 0) timeCap = view.time_cap_seconds;
  if (typeof d.requested_by_you === 'boolean') view.requested_by_you = d.requested_by_you;
  if (typeof d.requested_by === 'string') view.requested_by = d.requested_by;
  return view;
}

/** Keep what only the caller-scoped route says (a frame never names a person). */
function withViewer(view: InvestigationView, prev: InvestigationView | undefined): InvestigationView {
  if (!prev) return view;
  return {
    ...view,
    requested_by_you: view.requested_by_you ?? prev.requested_by_you,
    requested_by: view.requested_by ?? prev.requested_by,
  };
}

function upsert(view: InvestigationView, now: number): void {
  if (ended.has(view.run_id)) return;
  const prev = runs.get(view.run_id);
  // A run is as old as its queueing: one the server began a while ago shows at once.
  const born = Date.parse(view.queued_at || view.started_at || '');
  const showAt = prev
    ? prev.showAt
    : Math.min(now + HOLD_OFF_MS, Math.max(now, Number.isFinite(born) ? born + HOLD_OFF_MS : now + HOLD_OFF_MS));
  runs.set(view.run_id, {
    view: withViewer(view, prev?.view),
    seenAt: prev?.seenAt ?? now,
    showAt,
    local: false,
    expiresAt: expiryOf(view, now),
  });
}

/**
 * When a run expires on this console: a minute after its deadline. The server is the
 * authority, so a run it still lists past that point (its hooks run after the cap) is
 * kept and checked again a minute later, never read in a loop.
 */
function expiryOf(view: InvestigationView, now: number): number {
  const deadline = Date.parse(view.deadline_at || '');
  if (!Number.isFinite(deadline)) return Infinity;
  const at = deadline + EXPIRY_GRACE_MS;
  return at > now ? at : now + EXPIRY_GRACE_MS;
}

function finish(view: InvestigationView, now: number): void {
  const prev = runs.get(view.run_id);
  runs.delete(view.run_id);
  ended.add(view.run_id);
  if (ended.size > ENDED_KEEP) ended.delete(ended.values().next().value as string);
  const caseId = view.case_id ?? prev?.view.case_id;
  const last = caseId ? finished.get(caseId) : undefined;
  // One finished run per case: the newest (a read's `recent` can list an older one).
  if (!caseId || last?.view.run_id === view.run_id) return;
  if (last && Date.parse(last.view.finished_at || '') > Date.parse(view.finished_at || '')) return;
  finished.set(caseId, {
    view: { ...withViewer(view, prev?.view), case_id: caseId },
    at: now,
    active: Boolean(prev),
    shown: prev ? now >= prev.showAt : false,
  });
}

function setNewRuns(count: unknown, now: number): void {
  const n = typeof count === 'number' && count > 0 ? Math.trunc(count) : 0;
  if (n && !newRuns) newRunsSince = now;
  newRuns = n;
}

/** Apply a reconcile read; `caseId` when it was narrowed to one case. */
function apply(body: InvestigationsActive, caseId: string | null): void {
  const now = Date.now();
  const serverNow = Date.parse(body.generated_at);
  if (Number.isFinite(serverNow)) skew = serverNow - now;
  const present = new Set<string>();
  for (const raw of body.items || []) {
    const view = parseRun(raw);
    if (!view || view.state === 'finished' || !view.case_id) continue;
    present.add(view.run_id);
    upsert(view, now);
  }
  for (const raw of body.recent || []) {
    const view = parseRun(raw);
    if (!view) continue;
    present.add(view.run_id);
    finish(view, now);
  }
  for (const [runId, entry] of runs) {
    if (present.has(runId) || (caseId && entry.view.case_id !== caseId)) continue;
    // Gone from the server (it ended long ago, or the backend restarted): drop it, unless
    // this console just started it and the server has not registered it yet.
    if (!entry.local || now - entry.seenAt > LOCAL_TTL_MS) runs.delete(runId);
  }
  setNewRuns(body.new_runs, now);
  if (body.slots && typeof body.slots.cap === 'number') slots = { in_use: body.slots.in_use, cap: body.slots.cap };
}

/** Read `GET /api/investigations/active` (coalesced; never throws). */
export function reconcileInvestigations(caseId?: string | null): Promise<void> {
  if (!readers || denied) return Promise.resolve();
  if (reading) {
    readAgain = true;
    return reading;
  }
  const gen = generation;
  reading = (async () => {
    try {
      const body = await getActiveInvestigations(caseId || null);
      if (gen === generation && body && typeof body === 'object') apply(body, caseId || null);
    } catch (error) {
      const status = (error as { status?: unknown } | null)?.status;
      // Not allowed (or signed out): stop asking until the next reader mounts.
      if (status === 401 || status === 403) denied = true;
    } finally {
      reading = null;
      lastRead = Date.now();
      if (gen === generation) {
        if (readAgain) {
          readAgain = false;
          void reconcileInvestigations();
        }
        refresh();
      }
    }
  })();
  return reading;
}

function onFrame(ev: StreamEvent): void {
  if (ev.type === 'overflow') {
    void reconcileInvestigations();
    return;
  }
  if (ev.type !== 'case.investigation') return;
  const now = Date.now();
  setNewRuns((ev.data as { new_runs?: unknown } | null)?.new_runs, now);
  const view = parseRun(ev.data);
  if (view?.state === 'finished') finish(view, now);
  else if (view?.case_id) {
    const known = runs.get(view.run_id);
    upsert(view, now);
    // A frame never says who started a run: ask the route about a new manual one.
    if (!known && view.trigger === 'manual') readAgain = true;
  }
  if (readAgain && !reading) {
    readAgain = false;
    void reconcileInvestigations();
  }
  refresh();
}

function onLive(next: boolean): void {
  const opened = next && !live;
  live = next;
  // The stream (re)opened: frames sent while it was down are not replayed, so read.
  if (opened) void reconcileInvestigations();
  refresh();
}

function build(now: number): InvestigationSnapshot {
  const byCase = new Map<string, InvestigationView>();
  for (const entry of runs.values()) {
    const caseId = entry.view.case_id;
    if (!caseId || now < entry.showAt) continue;
    if (byCase.get(caseId)?.state === 'running' && entry.view.state !== 'running') continue;
    byCase.set(caseId, entry.view);
  }
  const shownRuns = newRuns && now >= newRunsSince + HOLD_OFF_MS ? newRuns : 0;
  return { byCase, finished: new Map(finished), newRuns: shownRuns, slots, live, timeCapSeconds: timeCap };
}

/**
 * The 5 s polling fallback applies: a reader, no live stream, and a run known. Never
 * while a read is in flight: its end refreshes and sets the next poll, so a slow read
 * cannot turn the poll into a busy loop.
 */
const polling = (): boolean =>
  readers > 0 && !live && !denied && reading === null && (runs.size > 0 || newRuns > 0);

/** Drop what expired, rebuild, notify, and set the next wake-up. */
function refresh(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const now = Date.now();
  let expired = false;
  let wake = Infinity;
  for (const [runId, entry] of runs) {
    const until = entry.expiresAt;
    if (now >= until) {
      runs.delete(runId);
      expired = true;
      continue;
    }
    wake = Math.min(wake, until, entry.showAt > now ? entry.showAt : Infinity);
  }
  for (const [caseId, run] of finished) {
    if (now >= run.at + FINISHED_TTL_MS) finished.delete(caseId);
    else wake = Math.min(wake, run.at + FINISHED_TTL_MS);
  }
  if (newRuns && newRunsSince + HOLD_OFF_MS > now) wake = Math.min(wake, newRunsSince + HOLD_OFF_MS);
  if (polling()) wake = Math.min(wake, Math.max(now, lastRead + POLL_MS));
  snapshot = build(now);
  setAiCaseCount(snapshot.byCase.size);
  for (const listener of [...listeners]) listener();
  if (expired) void reconcileInvestigations();
  if (readers > 0 && wake < Infinity) {
    timer = setTimeout(() => {
      timer = null;
      if (polling() && Date.now() >= lastRead + POLL_MS) void reconcileInvestigations();
      refresh();
    }, Math.max(0, Math.min(wake - now, 2_147_000_000)));
  }
}

function reset(): void {
  generation += 1;
  if (timer) clearTimeout(timer);
  timer = null;
  stopStream?.();
  stopStream = null;
  runs.clear();
  finished.clear();
  ended.clear();
  newRuns = 0;
  slots = null;
  timeCap = null;
  live = false;
  skew = 0;
  denied = false;
  lastRead = 0;
  reading = null;
  readAgain = false;
  snapshot = EMPTY;
  setAiCaseCount(0);
}

/**
 * Subscribe a reader. `active` readers (a viewer who may read cases) start the stream
 * subscription and the reconcile read; the last one to leave clears the store.
 */
function subscribe(listener: () => void, active: boolean): () => void {
  listeners.add(listener);
  if (active) {
    readers += 1;
    if (readers === 1) {
      try {
        stopStream = subscribeEvents(['investigations'], { onEvent: onFrame, onLive });
      } catch {
        stopStream = null; // realtime is advisory: the store still reads and polls
      }
      void reconcileInvestigations();
    }
  }
  return () => {
    listeners.delete(listener);
    if (!active) return;
    readers -= 1;
    if (readers === 0) reset();
  };
}

/**
 * Hold the store as a reader that may see cases, with no React component (the navigation's
 * count, `count.ts`). Returns the release.
 */
export function holdInvestigations(): () => void {
  return subscribe(() => undefined, true);
}

/** Read the store through `select` (which must return a stable value for a snapshot). */
export function useInvestigations<T>(select: (snapshot: InvestigationSnapshot) => T, active = true): T {
  const sub = React.useCallback((listener: () => void) => subscribe(listener, active), [active]);
  return React.useSyncExternalStore(sub, () => select(snapshot), () => select(EMPTY));
}

/**
 * This console started a run (the `202` of a non-blocking Reinvestigate): show it at
 * once, as queued and started by you, until the server's frames or read take over.
 */
export function noteReinvestigationStarted(caseId: string, runId: string): void {
  if (!caseId || !runId) return;
  const now = Date.now();
  const ended = finished.get(caseId);
  if (ended?.view.run_id === runId) {
    // A quick run can end before its `202` arrives, or inside the 1 s hold-off: this
    // console still started it, so its end shows (the tint, the toast) and the case is
    // read again.
    if (!ended.shown || !ended.view.requested_by_you) {
      finished.set(caseId, {
        view: { ...ended.view, requested_by_you: true },
        at: ended.shown ? ended.at : now,
        active: true,
        shown: true,
      });
      refresh();
    }
    return;
  }
  const known = runs.get(runId);
  if (known) {
    // Its first frame came before the `202`: this console started it, so it shows now
    // (no hold-off) and as yours.
    known.showAt = Math.min(known.showAt, now);
    known.view = { ...known.view, requested_by_you: true };
    refresh();
    return;
  }
  runs.set(runId, {
    view: {
      run_id: runId,
      case_id: caseId,
      state: 'queued',
      phase: 'queued',
      trigger: 'manual',
      queued_at: new Date(now).toISOString(),
      started_at: null,
      deadline_at: null,
      time_cap_seconds: 0,
      finished_at: null,
      outcome: null,
      status_after: null,
      verdict_after: null,
      requested_by_you: true,
    },
    seenAt: now,
    showAt: now,
    local: true,
    expiresAt: now + LOCAL_TTL_MS,
  });
  refresh();
}

/** The current snapshot (tests and non-React callers). */
export function investigationSnapshot(): InvestigationSnapshot {
  return snapshot;
}

/** Forget everything and every reader (tests only). */
export function resetInvestigationsForTests(): void {
  listeners.clear();
  readers = 0;
  reset();
}
