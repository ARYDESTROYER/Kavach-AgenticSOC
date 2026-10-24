/**
 * Case Manager's suggested questions, requested as the Chat tab is chosen (Round 13
 * polish, re-shoot PW2-6).
 *
 * The case chips came from `useChatStarters` inside the lazy case chat, so their request
 * waited for the chat's code to arrive and mount (measured on Demo: 0.5 to 4 s after the
 * tab click under the dev server, against a server answer of about 10 ms). The tab's
 * shell (`CaseChatPanel`) now starts `GET /api/chat/starters?surface=case` the moment
 * it mounts, beside the chat's own `import()`, and the hook takes that response instead
 * of asking again.
 *
 * Kept tiny and beside the shell on purpose: it imports only the console's request
 * helper, so the Case Detail shell keeps its rule of no static import under `soc/chat/`
 * (`entry-boundary.test.ts`). Only the shell and `CaseChat` (loaded from the shell) use
 * it, so it stays inside the Case Detail chunk: no new chunk, and nothing reaches the
 * entry chunk or its preload lists. `CaseChat` hands the read to `useChatStarters`. A
 * response serves the same viewer and case within {@link PREFETCH_TTL_MS} (the hook's
 * own cache, 60 s, takes over once it has an answer); anything else is ignored and the
 * hook asks the server itself. A failed prefetch is the hook's read failing (one read
 * per case, as before; a forced refresh or Retry reads again) and is not kept. No read
 * stays in memory past its time limit, and another viewer never gets one (sign-out
 * included), without this module listening to the chat's activity store, which would
 * add a dependency to every page's preload list.
 *
 * Reopening the tab (re-shoot PW3-6): once the chat has taken a read, its hook answers
 * from its own cache for {@link HOOK_CACHE_MS}, so choosing the tab again in that time
 * starts no read (a read nobody would use). Measured from the take, which comes before
 * the answer, so the skip never outlasts the hook's cache; a failed read is forgotten at
 * once, and another viewer or case always reads.
 *
 * Demo Mode (PR #132 review): every read also carries the Demo scope it was started
 * under ({@link caseStartersScope}: `off`, or the active run, which the tab's shell and
 * the chat both pass), and a read is handed over, or counted as taken, only under that
 * same scope. A reset re-seeds the same case ids, so without it a read started for the
 * previous run could serve the new one; the chat hook's own cache drops its answers on
 * the same switch. Only a confirmed Demo status read names a scope (PR #132 verify): the
 * provider's OFF stand-in, after a failed read, keeps the last confirmed scope, so a
 * failed 20 s poll starts no read; before any confirmed read the scope is unknown
 * (null), and a read started then belongs to the first scope a confirmed read names
 * (that read is no switch), so it is still handed over once the status lands.
 */
import { request } from '@/lib/api';

/** How long a prefetched answer may wait for the chat to take it. */
export const PREFETCH_TTL_MS = 30_000;
/**
 * The chat hook's own cache window (`useChatStarters` `STARTERS_CACHE_TTL_MS`, 60 s,
 * pinned equal by the tests): a constant here, so this module imports nothing from
 * `soc/chat`.
 */
export const HOOK_CACHE_MS = 60_000;
const LIMIT = 8;

interface Prefetch {
  at: number;
  principal: string;
  /** The Demo scope the read was started under (null: no confirmed status read yet). */
  scope: string | null;
  promise: Promise<unknown>;
}

const pending = new Map<string, Prefetch>();
/** When the chat first took a case's read, per case: its hook's cache answers after that. */
const taken = new Map<string, { at: number; principal: string; scope: string | null; promise: Promise<unknown> }>();
/** The scope the last confirmed Demo status read named (null: none yet). */
let confirmedScope: string | null = null;

/** The part of the shared Demo context (`useDemo()`) a scope reads. */
export interface CaseStartersDemoView {
  active: boolean;
  /** `false` for the provider's OFF stand-in (no read yet, or a failed read). */
  confirmed?: boolean;
  status: { run_id?: string | null };
}

/**
 * The Demo scope of a read, from the shared Demo context (`useDemo()`): `off`, or
 * `demo:<run id>` while Demo is on, as the last confirmed status read named it. The
 * provider's stand-in (`confirmed: false`) names nothing, so the last confirmed scope
 * holds (null before any). Render phase, module state only; the tab's shell and the
 * chat pass the same value.
 */
export function caseStartersScope(demo: CaseStartersDemoView): string | null {
  if (demo.confirmed !== false) confirmedScope = demo.active ? `demo:${demo.status.run_id ?? ''}` : 'off';
  return confirmedScope;
}

/**
 * Whether a read (or a take) recorded under `entry.scope` serves `scope`. A read started before any
 * confirmed status read (null) belongs to the first scope one names, and is bound to it.
 */
function sameScope(entry: { scope: string | null }, scope: string | null): boolean {
  if (entry.scope === null) {
    entry.scope = scope;
    return true;
  }
  return entry.scope === scope;
}

function trim(map: Map<string, unknown>): void {
  while (map.size > LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** A case id the starters endpoint accepts (`chat-api` `getChatStarters`). */
function validCaseId(caseId: string | null | undefined): caseId is string {
  return typeof caseId === 'string' && caseId.length > 0 && caseId.length <= 128;
}

/**
 * Start the case's suggestions read now (Chat tab chosen). A read already waiting for
 * this case, viewer and Demo scope is reused. Never throws; a failed read is simply not
 * taken.
 */
export function prefetchCaseStarters(
  caseId: string | null | undefined,
  principal: string | null | undefined,
  now = Date.now(),
  scope: string | null = null,
): void {
  if (!validCaseId(caseId)) return;
  const viewer = principal ?? '';
  const existing = pending.get(caseId);
  if (existing && existing.principal === viewer && now - existing.at < PREFETCH_TTL_MS && sameScope(existing, scope)) return;
  // The chat took this case's read moments ago: its hook answers from its own cache
  // (under the same Demo scope only: a switch drops that cache).
  const took = taken.get(caseId);
  if (took && took.principal === viewer && now - took.at < HOOK_CACHE_MS && sameScope(took, scope)) return;
  const promise = request<unknown>('GET', 'chat/starters', { query: { surface: 'case', case_id: caseId } });
  const entry: Prefetch = { at: now, principal: viewer, scope, promise };
  const drop = () => {
    if (pending.get(caseId) === entry) pending.delete(caseId);
  };
  // Taken or not, a failure never surfaces as an unhandled rejection, and it is not kept:
  // the next time the tab opens it asks again.
  promise.catch(drop);
  // Nothing outlives its time limit in memory (a signed-out viewer's answer included).
  setTimeout(drop, PREFETCH_TTL_MS);
  pending.delete(caseId);
  pending.set(caseId, entry);
  trim(pending);
}

/**
 * The raw response a prefetch holds for this case, viewer and Demo scope; `null` when
 * there is none (or it is stale, or another viewer or Demo scope started it). Not
 * removed when read: React's development double effect reads it twice, and the hook's
 * cache answers after that.
 */
export function takeCaseStartersPrefetch(
  caseId: string | null | undefined,
  principal: string | null | undefined,
  now = Date.now(),
  scope: string | null = null,
): Promise<unknown> | null {
  if (!validCaseId(caseId)) return null;
  const entry = pending.get(caseId);
  if (!entry) return null;
  if (entry.principal !== (principal ?? '') || now - entry.at >= PREFETCH_TTL_MS || !sameScope(entry, scope)) {
    pending.delete(caseId);
    return null;
  }
  recordTaken(caseId, entry, now);
  return entry.promise;
}

/** The first take of a read starts the window in which reopening the tab reads nothing. */
function recordTaken(caseId: string, entry: Prefetch, now: number): void {
  const previous = taken.get(caseId);
  if (previous && previous.promise === entry.promise) return;
  const record = { at: now, principal: entry.principal, scope: entry.scope, promise: entry.promise };
  const forget = () => {
    if (taken.get(caseId) === record) taken.delete(caseId);
  };
  // A failed read gave the hook nothing to cache: the next time the tab opens it reads.
  entry.promise.catch(forget);
  setTimeout(forget, HOOK_CACHE_MS);
  taken.delete(caseId);
  taken.set(caseId, record);
  trim(taken);
}

/** Drop every waiting read (tests; each read also leaves memory after its time limit). */
export function clearCaseStartersPrefetch(): void {
  pending.clear();
  taken.clear();
  confirmedScope = null;
}
