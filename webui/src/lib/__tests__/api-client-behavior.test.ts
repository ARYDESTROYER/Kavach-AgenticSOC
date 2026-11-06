/**
 * lib/api client-behavior regressions (Round-6 sources batch).
 *
 *   - Dashboard writes default to a TRAILING-debounce that coalesces a rapid drag/resize
 *     stream to the same id into one PUT (finding 17 / the `dashboards-route` coalescing
 *     contract), while an EXPLICIT Save (`{ immediate: true }`) fires right away —
 *     flushing any pending settle — so the primary action never eats the 500ms delay.
 *   - extractMessage turns a CODED backend error ({code,reason} with no human string) into
 *     a readable sentence instead of a raw JSON blob (finding 18).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ApiError, setReauthHandler } from '../api';
import { listRunbookLibrary } from '../api-runbooks';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function blobResponse(
  status: number,
  body: Blob,
  headers: Record<string, string> = {},
): Response {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => normalized[name.toLowerCase()] || null },
    blob: async () => body,
    json: async () => {
      throw new Error('not json');
    },
    text: async () => '',
  } as unknown as Response;
}

describe('binary downloads preserve the central auth and error boundary', () => {
  afterEach(() => {
    setReauthHandler(null);
    vi.unstubAllGlobals();
  });

  it('returns the Blob and download headers only after a successful response', async () => {
    const archive = new Blob(['zip'], { type: 'application/zip' });
    const fetchMock = vi.fn().mockResolvedValue(blobResponse(200, archive, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="export.zip"',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const result = await api.dataExport.archive(['cases'], controller.signal);

    expect(result).toEqual({
      blob: archive,
      contentType: 'application/zip',
      contentDisposition: 'attachment; filename="export.zip"',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual([
      '/api/admin/export/archive',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        signal: controller.signal,
        body: JSON.stringify({ scopes: ['cases'] }),
        headers: { 'Content-Type': 'application/json' },
      }),
    ]);
  });

  it('turns a non-2xx JSON response into ApiError without reading a Blob', async () => {
    const errorResponse = jsonResponse(503, { detail: 'archive assembly failed' });
    const blobSpy = vi.fn();
    Object.assign(errorResponse, { blob: blobSpy });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse));

    await expect(api.dataExport.archive(['cases'])).rejects.toEqual(
      expect.objectContaining<ApiError>({
        name: 'ApiError',
        status: 503,
        message: 'archive assembly failed',
      }),
    );
    expect(blobSpy).not.toHaveBeenCalled();
  });

  it('retries a reauth-required Blob request exactly once through the shared gate', async () => {
    const gate = vi.fn().mockResolvedValue(true);
    setReauthHandler(gate);
    const archive = new Blob(['zip'], { type: 'application/zip' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(401, { detail: { code: 'reauth_required' } }))
      .mockResolvedValueOnce(blobResponse(200, archive, {
        'Content-Type': 'application/zip',
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.dataExport.archive(['cases']);

    expect(result.blob).toBe(archive);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toEqual(fetchMock.mock.calls[0][1]);
  });

  it('does not recurse when the one reauth retry is also rejected', async () => {
    const gate = vi.fn().mockResolvedValue(true);
    setReauthHandler(gate);
    const fetchMock = vi.fn()
      .mockResolvedValue(jsonResponse(401, { detail: { code: 'reauth_required' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.dataExport.archive(['cases'])).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(gate).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('dashboard update: default trailing-debounce + immediate Save path (finding 17)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: 'x' }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('an EXPLICIT Save ({ immediate: true }) fires the PUT NOW (never eats the 500ms debounce)', () => {
    void api.dashboards.update('iso-1', { id: 'iso-1' } as never, { immediate: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/dashboards/iso-1');
    expect((init as RequestInit).method).toBe('PUT');
  });

  it('the DEFAULT (drag/resize stream) trailing-debounces a burst to the same id into ONE PUT', async () => {
    void api.dashboards.update('burst-1', { id: 'burst-1', v: 1 } as never);
    void api.dashboards.update('burst-1', { id: 'burst-1', v: 2 } as never);
    void api.dashboards.update('burst-1', { id: 'burst-1', v: 3 } as never);
    expect(fetchMock).toHaveBeenCalledTimes(0); // trailing only — nothing sent before the window elapses
    await vi.advanceTimersByTimeAsync(600);
    expect(fetchMock).toHaveBeenCalledTimes(1); // one coalesced trailing PUT
  });

  it('an immediate Save FLUSHES a pending settle: one immediate PUT, no stray trailing PUT', async () => {
    void api.dashboards.update('flush-1', { id: 'flush-1', v: 1 } as never); // opens a trailing window
    expect(fetchMock).toHaveBeenCalledTimes(0);
    // Save arrives mid-settle → immediate PUT that cancels + folds the pending settle.
    void api.dashboards.update('flush-1', { id: 'flush-1', v: 2 } as never, { immediate: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the pending settle was cancelled — no second PUT
  });
});

describe('extractMessage humanizes coded errors (finding 18)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps a coded session_invalid detail to a readable sentence (not raw JSON)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { detail: { code: 'session_invalid', reason: 'refresh_reuse' } }),
    );
    await expect(api.get('cases')).rejects.toThrowError(
      'Your session is no longer valid. Please sign in again.',
    );
  });

  it('prefers a human `message` field when present', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { detail: { message: 'boom', code: 'x' } }));
    await expect(api.get('cases')).rejects.toThrowError('boom');
  });

  it('falls back to a generic message for an unknown code (never a JSON blob)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { detail: { code: 'mystery' } }));
    await expect(api.get('cases')).rejects.toThrowError('Request failed (500)');
  });
});

describe('PATCH verb + typed config clients (round-6 api helpers)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, config: {} }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('api.patch issues a PATCH with a JSON body (case-collab thread/task edits 405 on PUT)', async () => {
    await api.patch('cases/c1/thread/m1', { body: 'edited' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/api/cases/c1/thread/m1');
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ body: 'edited' });
  });

  it('api.tuning.getConfig / putConfig hit the PLURAL-free /api/tuning/config route', async () => {
    await api.tuning.getConfig();
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/tuning/config');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('GET');

    await api.tuning.putConfig({ enabled: true });
    expect(String(fetchMock.mock.calls[1][0])).toBe('/api/tuning/config');
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('PUT');
  });

  it('api.campaign config uses the PLURAL /api/campaigns/config route (not the singular)', async () => {
    await api.campaign.getConfig();
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/campaigns/config');
  });
});

describe('proposal decision response normalization', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(['approve', 'reject'] as const)(
    'returns the updated proposal row from the backend %s envelope',
    async (decision) => {
      const proposal = { id: 'proposal-1', kind: 'tuning', status: `${decision}d` };
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, proposal }));
      vi.stubGlobal('fetch', fetchMock);

      const result =
        decision === 'approve'
          ? await api.approveProposal('proposal-1')
          : await api.rejectProposal('proposal-1');

      expect(result).toEqual(proposal);
      expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/proposals/proposal-1/${decision}`);
    },
  );
});

describe('release coherence reads', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('threads no-store and AbortSignal through health and build-info reads', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        status: 'ok',
        version: '0.1.1',
        service: 'tlsoc-agentic-triage',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await api.health({ cache: 'no-store', signal: controller.signal });
    await api.buildInfo({ cache: 'no-store', signal: controller.signal });

    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toEqual(
        expect.objectContaining({ cache: 'no-store', signal: controller.signal }),
      );
    }
  });
});

describe('supervised system-update request authority', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends only opaque server ids, tokens, and idempotency keys in mutations', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    await api.systemUpdates.preflight('stable-release-id', 'preflight-operation-id');
    await api.systemUpdates.start('stable-release-id', 'server-bound-token', 'start-operation-id');
    await api.systemUpdates.cancel('durable-job-id', 'cancel-operation-id');
    await api.systemUpdates.rollback('durable-job-id', 'rollback-operation-id');

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      body: JSON.parse((init as RequestInit).body as string),
    }));
    expect(requests).toEqual([
      {
        url: '/api/system-updates/preflight',
        body: { release_id: 'stable-release-id', idempotency_key: 'preflight-operation-id' },
      },
      {
        url: '/api/system-updates/jobs',
        body: {
          release_id: 'stable-release-id',
          preflight_token: 'server-bound-token',
          idempotency_key: 'start-operation-id',
        },
      },
      {
        url: '/api/system-updates/jobs/durable-job-id/cancel',
        body: { idempotency_key: 'cancel-operation-id' },
      },
      {
        url: '/api/system-updates/jobs/durable-job-id/rollback',
        body: { idempotency_key: 'rollback-operation-id' },
      },
    ]);
    expect(JSON.stringify(requests)).not.toMatch(/https?:|image|digest|command|compose|path/i);
  });
});

describe('Runbooks after Round 14: one library client, no legacy normalisation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the library in the Round 14 shape exactly as the server sent it', async () => {
    // The pre-Round 14 catalog shape (`enabled`, `count`, `source_type`, the authoring
    // standard) was normalised by `api.getRunbooks`. That call is retired: the library is
    // read through `listRunbookLibrary`, which never asks for `shape=v1` and never
    // invents fields, so a stale server shape is visible instead of being papered over.
    const library = {
      runbooks: [
        {
          id: 'brute_force_login',
          title: 'Brute force and password spray',
          origin: 'builtin',
          state: 'published',
          live_version: 1,
        },
      ],
      migration: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, library));
    vi.stubGlobal('fetch', fetchMock);

    const result = await listRunbookLibrary();

    expect(fetchMock.mock.calls[0][0]).toBe('/api/runbooks');
    expect(result).toEqual(library);
    const client = api as unknown as Record<string, unknown>;
    for (const retired of ['getRunbooks', 'getRunbook', 'createRunbook', 'updateRunbook', 'deleteRunbook']) {
      expect(client[retired], retired).toBeUndefined();
    }
  });

  it('surfaces an old-shape write as 410 runbooks_moved with the server sentence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(410, {
          detail: 'Runbooks moved: write them through the runbook library.',
          code: 'runbooks_moved',
          see: '/api/runbooks',
        }),
      ),
    );

    const error = await api.post('runbooks', { id: 'old', content: '# Old' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(410);
    expect((error as ApiError).message).toBe('Runbooks moved: write them through the runbook library.');
    expect((error as ApiError).body).toMatchObject({ code: 'runbooks_moved' });
  });
});
