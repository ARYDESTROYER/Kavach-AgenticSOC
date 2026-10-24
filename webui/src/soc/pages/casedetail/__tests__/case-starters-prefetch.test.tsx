/**
 * Case Manager's suggested questions are read as the Chat tab is chosen (Round 13
 * polish, re-shoot PW2-6): the tab's shell starts `GET /api/chat/starters?surface=case`
 * beside the chat's lazy import, and `useChatStarters` uses that response instead of
 * asking again (the request used to wait for the chat's code: 0.5 to 4 s on Demo). The
 * read is per viewer and case and short-lived; a failed one is the hook's failed read
 * (one read, as before), and Retry reads again. It is also per Demo run (PR #132): a
 * reset re-seeds the same case ids, and a read started for one run never serves another.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, waitFor } from '@testing-library/react';

import {
  caseStartersScope,
  clearCaseStartersPrefetch,
  HOOK_CACHE_MS,
  PREFETCH_TTL_MS,
  prefetchCaseStarters,
  takeCaseStartersPrefetch,
} from '../case-starters-prefetch';
import { STARTERS_CACHE_TTL_MS, clearChatStartersCache, useChatStarters } from '@/soc/chat/starters/useChatStarters';
import { NEEDS_HUMAN, json, makeInfo, query, stubStarterFetch } from '@/soc/chat/starters/__tests__/fixtures';

const CASE_INFO = () => makeInfo({ surface: 'case', starters: [{ ...NEEDS_HUMAN }] });

beforeEach(() => {
  clearChatStartersCache();
  clearCaseStartersPrefetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('prefetchCaseStarters', () => {
  it('reads the case surface once per case and viewer while fresh', async () => {
    const server = stubStarterFetch(() => json(CASE_INFO()));
    prefetchCaseStarters('case-0042', 'alice', 1_000);
    prefetchCaseStarters('case-0042', 'alice', 2_000);
    await waitFor(() => expect(server.reads()).toHaveLength(1));
    expect(Object.fromEntries(query(server.reads()[0]))).toEqual({ surface: 'case', case_id: 'case-0042' });
    // Another viewer, or a stale read, starts a new one.
    prefetchCaseStarters('case-0042', 'bob', 3_000);
    prefetchCaseStarters('case-0042', 'bob', 3_000 + PREFETCH_TTL_MS);
    await waitFor(() => expect(server.reads()).toHaveLength(3));
  });

  it('serves only the same viewer and case within the time limit', async () => {
    stubStarterFetch(() => json(CASE_INFO()));
    prefetchCaseStarters('case-0042', 'alice', 1_000);
    expect(takeCaseStartersPrefetch('case-0099', 'alice', 1_100)).toBeNull();
    expect(takeCaseStartersPrefetch('case-0042', 'bob', 1_100)).toBeNull();
    // A wrong viewer drops it: the right one asks the server itself.
    expect(takeCaseStartersPrefetch('case-0042', 'alice', 1_200)).toBeNull();
    prefetchCaseStarters('case-0042', 'alice', 2_000);
    expect(takeCaseStartersPrefetch('case-0042', 'alice', 2_000 + PREFETCH_TTL_MS)).toBeNull();
    prefetchCaseStarters('case-0042', 'alice', 5_000);
    const taken = takeCaseStartersPrefetch('case-0042', 'alice', 5_100);
    expect(taken).not.toBeNull();
    await expect(taken).resolves.toMatchObject({ surface: 'case' });
  });

  it('keeps no failed read', async () => {
    const server = stubStarterFetch(() => json({ detail: 'Down' }, 503));
    prefetchCaseStarters('case-0042', 'alice');
    await waitFor(() => expect(server.reads()).toHaveLength(1));
    await waitFor(() => expect(takeCaseStartersPrefetch('case-0042', 'alice')).toBeNull());
    // The tab opened again: it asks again.
    prefetchCaseStarters('case-0042', 'alice');
    await waitFor(() => expect(server.reads()).toHaveLength(2));
  });

  it('lets no read outlive its time limit in memory', async () => {
    vi.useFakeTimers();
    try {
      stubStarterFetch(() => json(CASE_INFO()));
      prefetchCaseStarters('case-0042', 'alice');
      expect(takeCaseStartersPrefetch('case-0042', 'alice')).not.toBeNull();
      await vi.advanceTimersByTimeAsync(PREFETCH_TTL_MS);
      // Even read with an old clock, the entry has gone.
      expect(takeCaseStartersPrefetch('case-0042', 'alice', 0)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands a read only to the Demo run it was started under (a reset re-seeds the same ids)', async () => {
    const server = stubStarterFetch(() => json(CASE_INFO()));
    const run1 = caseStartersScope({ active: true, status: { run_id: 'run-1' } });
    const run2 = caseStartersScope({ active: true, status: { run_id: 'run-2' } });
    expect(caseStartersScope({ active: false, status: { run_id: '' } })).toBe('off');
    expect(run1).not.toBe(run2);
    prefetchCaseStarters('demo-1337-0001', 'alice', 1_000, run1);
    expect(takeCaseStartersPrefetch('demo-1337-0001', 'alice', 1_100, run2)).toBeNull();
    // Out of Demo, or in the next run, a new read starts (the old one was dropped).
    expect(takeCaseStartersPrefetch('demo-1337-0001', 'alice', 1_200, run1)).toBeNull();
    prefetchCaseStarters('demo-1337-0001', 'alice', 1_300, run2);
    await waitFor(() => expect(server.reads()).toHaveLength(2));
    expect(takeCaseStartersPrefetch('demo-1337-0001', 'alice', 1_400, run2)).not.toBeNull();
  });

  it('skips a reopen read only within the same Demo run', async () => {
    const server = stubStarterFetch(() => json(CASE_INFO()));
    const run1 = caseStartersScope({ active: true, status: { run_id: 'run-1' } });
    prefetchCaseStarters('demo-1337-0001', 'alice', 1_000, run1);
    expect(takeCaseStartersPrefetch('demo-1337-0001', 'alice', 1_100, run1)).not.toBeNull();
    // Reopened in the same run while its hook still has the answer: no read.
    prefetchCaseStarters('demo-1337-0001', 'alice', 1_000 + PREFETCH_TTL_MS + 1, run1);
    await waitFor(() => expect(server.reads()).toHaveLength(1));
    // Reopened after Exit demo (or a reset): the hook dropped that answer, so it reads.
    prefetchCaseStarters('demo-1337-0001', 'alice', 1_000 + PREFETCH_TTL_MS + 2, 'off');
    await waitFor(() => expect(server.reads()).toHaveLength(2));
  });

  it('a failed Demo status read names no scope: the last confirmed one holds and no read starts', async () => {
    const server = stubStarterFetch(() => json(CASE_INFO()));
    const standIn = { active: false, confirmed: false, status: { run_id: null } };
    // Before any confirmed read the scope is unknown.
    expect(caseStartersScope(standIn)).toBeNull();
    const run1 = caseStartersScope({ active: true, confirmed: true, status: { run_id: 'run-1' } });
    expect(run1).toBe('demo:run-1');
    prefetchCaseStarters('demo-1337-0001', 'alice', 1_000, run1);
    // A 503 from the status poll while Demo stays on: the tab re-renders with the stand-in.
    expect(caseStartersScope(standIn)).toBe(run1);
    prefetchCaseStarters('demo-1337-0001', 'alice', 1_100, caseStartersScope(standIn));
    expect(takeCaseStartersPrefetch('demo-1337-0001', 'alice', 1_200, caseStartersScope(standIn))).not.toBeNull();
    await waitFor(() => expect(server.reads()).toHaveLength(1));
    // A confirmed switch after the outage is still another scope.
    expect(caseStartersScope({ active: false, confirmed: true, status: { run_id: null } })).toBe('off');
    expect(takeCaseStartersPrefetch('demo-1337-0001', 'alice', 1_300, 'off')).toBeNull();
  });

  it('hands a read started before the first status read lands to the scope that read names', async () => {
    const server = stubStarterFetch(() => json(CASE_INFO()));
    const standIn = { active: false, confirmed: false, status: { run_id: null } };
    prefetchCaseStarters('demo-1337-0001', 'alice', 1_000, caseStartersScope(standIn));
    // The status lands (Demo on): the tab's effect runs again under the run, reusing the read.
    const run1 = caseStartersScope({ active: true, confirmed: true, status: { run_id: 'run-1' } });
    prefetchCaseStarters('demo-1337-0001', 'alice', 1_100, run1);
    expect(takeCaseStartersPrefetch('demo-1337-0001', 'alice', 1_200, run1)).not.toBeNull();
    await waitFor(() => expect(server.reads()).toHaveLength(1));
    // It now belongs to that run: a reset's scope never gets it.
    expect(takeCaseStartersPrefetch('demo-1337-0001', 'alice', 1_300, 'demo:run-2')).toBeNull();
  });

  it('makes no request for an id the endpoint does not take, and never rejects unhandled', async () => {
    const server = stubStarterFetch(() => json({ detail: 'Down' }, 503));
    prefetchCaseStarters('', 'alice');
    prefetchCaseStarters('x'.repeat(129), 'alice');
    prefetchCaseStarters(null, 'alice');
    expect(server.reads()).toHaveLength(0);
    prefetchCaseStarters('case-0042', 'alice');
    await waitFor(() => expect(server.reads()).toHaveLength(1));
  });
});

describe('useChatStarters on the case surface', () => {
  // As `CaseChat` wires it: the hook reads the Chat tab's read for its own case and viewer.
  function renderCase(principal = 'alice') {
    return renderHook(() =>
      useChatStarters({ surface: 'case', caseId: 'case-0042', principal, takePrefetched: () => takeCaseStartersPrefetch('case-0042', principal) }),
    );
  }

  it('uses a read the Chat tab started instead of asking again', async () => {
    const server = stubStarterFetch(() => json(CASE_INFO()));
    prefetchCaseStarters('case-0042', 'alice');
    const { result } = renderCase();
    await waitFor(() => expect(result.current.info?.starters.map((s) => s.id)).toEqual(['needs_human']));
    expect(server.reads()).toHaveLength(1);
  });

  it('takes a failed started read as its own (one read), and Retry reads again', async () => {
    let calls = 0;
    const server = stubStarterFetch(() => {
      calls += 1;
      return calls === 1 ? json({ detail: 'Suggestions are down.' }, 503) : json(CASE_INFO());
    });
    prefetchCaseStarters('case-0042', 'alice');
    const { result } = renderCase();
    await waitFor(() => expect(result.current.error).toBe('Suggestions are down.'));
    expect(server.reads()).toHaveLength(1);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.info?.starters).toHaveLength(1));
    expect(server.reads()).toHaveLength(2);
  });

  it("mirrors the hook's cache window without importing the chat package", () => {
    expect(HOOK_CACHE_MS).toBe(STARTERS_CACHE_TTL_MS);
  });

  it('reopening the Chat tab while the hook still has the answer starts no read (re-shoot PW3-6)', async () => {
    // Live, the tab chosen again 45 s after its read was taken sent a read nobody used:
    // the prefetch had expired (30 s) while the hook's cache (60 s) was still fresh.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = Date.UTC(2026, 9, 23, 12, 0, 0);
      vi.setSystemTime(t0);
      const server = stubStarterFetch(() => json(CASE_INFO()));
      prefetchCaseStarters('case-0042', 'alice');
      const first = renderCase();
      await waitFor(() => expect(first.result.current.info).not.toBeNull());
      first.unmount();
      expect(server.reads()).toHaveLength(1);

      // Back to the tab at 45 s: the hook answers from its cache, so no read starts.
      vi.setSystemTime(t0 + 45_000);
      prefetchCaseStarters('case-0042', 'alice');
      const again = renderCase();
      await waitFor(() => expect(again.result.current.info?.starters.map((s) => s.id)).toEqual(['needs_human']));
      again.unmount();
      expect(server.reads()).toHaveLength(1);

      // Another viewer, or another case, still reads at once.
      prefetchCaseStarters('case-0042', 'bob');
      prefetchCaseStarters('case-0099', 'alice');
      await waitFor(() => expect(server.reads()).toHaveLength(3));

      // Once the hook's cache has lapsed, the tab reads again, and the hook takes that read.
      vi.setSystemTime(t0 + HOOK_CACHE_MS + 1_000);
      prefetchCaseStarters('case-0042', 'alice');
      await waitFor(() => expect(server.reads()).toHaveLength(4));
      const later = renderCase();
      await waitFor(() => expect(later.result.current.info).not.toBeNull());
      expect(server.reads()).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads again on reopening after a failed read, whose answer nothing cached', async () => {
    let calls = 0;
    const server = stubStarterFetch(() => {
      calls += 1;
      return calls === 1 ? json({ detail: 'Suggestions are down.' }, 503) : json(CASE_INFO());
    });
    prefetchCaseStarters('case-0042', 'alice');
    const first = renderCase();
    await waitFor(() => expect(first.result.current.error).toBe('Suggestions are down.'));
    first.unmount();
    prefetchCaseStarters('case-0042', 'alice');
    await waitFor(() => expect(server.reads()).toHaveLength(2));
    const again = renderCase();
    await waitFor(() => expect(again.result.current.info?.starters).toHaveLength(1));
    expect(server.reads()).toHaveLength(2);
  });

  it('never hands one viewer the read started for another', async () => {
    const server = stubStarterFetch(() => json(CASE_INFO()));
    prefetchCaseStarters('case-0042', 'bob');
    const { result } = renderCase('alice');
    await waitFor(() => expect(result.current.info).not.toBeNull());
    expect(server.reads()).toHaveLength(2);
  });
});

describe("Case Manager's Chat tab", () => {
  it('starts the case read as it mounts, before the lazy chat arrives', async () => {
    const server = stubStarterFetch(() => json(CASE_INFO()));
    // The chat body stays suspended here: the read must not wait for it.
    const pending = new Promise(() => {});
    vi.doMock('../CaseChat', () => ({
      default: () => {
        throw pending;
      },
    }));
    const { ChatTab } = await import('../CaseChatPanel');
    render(
      <React.Suspense fallback={null}>
        <ChatTab c={{ case_id: 'case-0042', case_number: 'CASE-000042' } as never} onClose={() => {}} presentation="case-manager" />
      </React.Suspense>,
    );
    await waitFor(() => expect(server.reads()).toHaveLength(1));
    expect(query(server.reads()[0]).get('case_id')).toBe('case-0042');
    vi.doUnmock('../CaseChat');
  });

  it('starts no second read when a Demo status poll fails, or when the first one lands', async () => {
    // PR #132 verify: the provider's stand-in (before the first read, after a failed
    // one) is no Demo switch, so the tab's read is neither repeated nor orphaned.
    const server = stubStarterFetch(() => json(CASE_INFO()));
    let statusFails = false;
    let releaseStatus: (() => void) | null = null;
    let statusReads = 0;
    const starters = server.fetchMock;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== '/api/demo/status') return starters(input, init);
      const answer = () =>
        statusFails ? json({ detail: 'Service unavailable' }, 503) : json({ mode: 'seeded', active: true, run_id: 'run-1' });
      statusReads += 1;
      if (statusReads === 1) {
        // The first status read is still in flight when the tab starts its read.
        return new Promise<Response>((resolve) => {
          releaseStatus = () => resolve(answer());
        });
      }
      return answer();
    });
    const pending = new Promise(() => {});
    vi.doMock('../CaseChat', () => ({
      default: () => {
        throw pending;
      },
    }));
    const { ChatTab } = await import('../CaseChatPanel');
    const { DemoProvider, useDemo } = await import('@/soc/demo');
    let demo: ReturnType<typeof useDemo> | null = null;
    const Probe = () => {
      demo = useDemo();
      return null;
    };
    render(
      <DemoProvider>
        <Probe />
        <React.Suspense fallback={null}>
          <ChatTab c={{ case_id: 'case-0042', case_number: 'CASE-000042' } as never} onClose={() => {}} presentation="case-manager" />
        </React.Suspense>
      </DemoProvider>,
    );
    await waitFor(() => expect(server.reads()).toHaveLength(1));
    expect(demo?.confirmed).toBe(false);
    expect(releaseStatus).not.toBeNull();
    await act(async () => releaseStatus?.());
    await waitFor(() => expect(demo?.active).toBe(true));
    statusFails = true;
    await act(async () => {
      await demo?.refresh();
    });
    expect(demo?.confirmed).toBe(false);
    statusFails = false;
    await act(async () => {
      await demo?.refresh();
    });
    expect(demo?.active).toBe(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(server.reads()).toHaveLength(1);
    expect(takeCaseStartersPrefetch('case-0042', null, Date.now(), 'demo:run-1')).not.toBeNull();
    vi.doUnmock('../CaseChat');
  });
});
