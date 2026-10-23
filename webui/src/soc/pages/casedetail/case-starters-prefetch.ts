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
  promise: Promise<unknown>;
}

const pending = new Map<string, Prefetch>();
/** When the chat first took a case's read, per case: its hook's cache answers after that. */
const taken = new Map<string, { at: number; principal: string; promise: Promise<unknown> }>();

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
 * this case and viewer is reused. Never throws; a failed read is simply not taken.
 */
export function prefetchCaseStarters(caseId: string | null | undefined, principal: string | null | undefined, now = Date.now()): void {
  if (!validCaseId(caseId)) return;
  const viewer = principal ?? '';
  const existing = pending.get(caseId);
  if (existing && existing.principal === viewer && now - existing.at < PREFETCH_TTL_MS) return;
  // The chat took this case's read moments ago: its hook answers from its own cache.
  const took = taken.get(caseId);
  if (took && took.principal === viewer && now - took.at < HOOK_CACHE_MS) return;
  const promise = request<unknown>('GET', 'chat/starters', { query: { surface: 'case', case_id: caseId } });
  const entry: Prefetch = { at: now, principal: viewer, promise };
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
 * The raw response a prefetch holds for this case and viewer; `null` when there is none
 * (or it is stale, or another viewer started it). Not removed when read: React's
 * development double effect reads it twice, and the hook's cache answers after that.
 */
export function takeCaseStartersPrefetch(caseId: string | null | undefined, principal: string | null | undefined, now = Date.now()): Promise<unknown> | null {
  if (!validCaseId(caseId)) return null;
  const entry = pending.get(caseId);
  if (!entry) return null;
  if (entry.principal !== (principal ?? '') || now - entry.at >= PREFETCH_TTL_MS) {
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
  const record = { at: now, principal: entry.principal, promise: entry.promise };
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
}
