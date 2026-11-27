import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

import type { BackgroundJob } from '@/lib/types';

const { listMock, getMock, toastMock, streamMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  getMock: vi.fn(),
  streamMock: vi.fn((_topics: string[], _opts?: { onEvent?: (event: { type: string; data: unknown; lastEventId: string }) => void }) => ({
    live: false,
  })),
  toastMock: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: getMock,
      jobs: { ...actual.api.jobs, list: listMock },
    },
  };
});
vi.mock('@/lib/useEventStream', () => ({
  useEventStream: streamMock,
}));
vi.mock('sonner', () => ({ toast: toastMock }));

import { setChatFrameSink, type ChatFrame } from '@/soc/chat-activity/store';
import { announceJobAccepted, releaseJobToast } from '../jobs';
import { JobMonitor } from '../JobMonitor';

function job(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    job_id: 'job-1',
    kind: 'case_reinvestigate',
    actor: 'analyst.one',
    created_at: '2026-08-13T10:00:00Z',
    started_at: '2026-08-13T10:00:01Z',
    finished_at: '2026-08-13T10:01:00Z',
    status: 'succeeded',
    progress: { done: 2, total: 2, unit: 'cases' },
    failures: [],
    failure_count: 0,
    failures_truncated: 0,
    request_fingerprint: 'fp',
    result: {
      kind: 'case_reinvestigate',
      counts: { succeeded: 2, failed: 0, total: 2 },
    },
    params: { case_ids: ['case-1', 'case-2'] },
    cancel_requested: false,
    ...overrides,
  };
}

function response(jobs: BackgroundJob[]) {
  return { jobs, total: jobs.length, limit: 100, offset: 0 };
}

describe('JobMonitor durable terminal delivery', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    listMock.mockReset();
    getMock.mockReset().mockResolvedValue({ items: [] });
    Object.values(toastMock).forEach((mock) => mock.mockReset());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not replay historical terminals on the first successful snapshot after offline return', async () => {
    listMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(response([job({ job_id: 'historical-job' })]));
    const view = render(<JobMonitor actor="analyst.one" onNavigate={vi.fn()} />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    // Remount models a Console return/reload after the job completed while offline.
    view.unmount();
    render(<JobMonitor actor="analyst.one" onNavigate={vi.fn()} />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.warning).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(toastMock.info).not.toHaveBeenCalled();
  });

  it('does announce a locally accepted job that becomes terminal before the first list snapshot', async () => {
    let resolveFirst: ((value: ReturnType<typeof response>) => void) | undefined;
    listMock
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce(response([job()]));
    render(<JobMonitor actor="analyst.one" onNavigate={vi.fn()} />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    act(() => {
      announceJobAccepted(
        job({
          status: 'queued',
          started_at: null,
          finished_at: null,
          progress: { done: 0, total: 2, unit: 'cases' },
          result: null,
        }),
      );
    });
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));
    expect(toastMock.success.mock.calls[0][0]).toBe('Case reinvestigate completed');
    // A non-artifact job never grows a dead secondary Download action.
    expect(toastMock.success.mock.calls[0][1]).not.toHaveProperty('cancel');

    // Resolve the superseded first request to prove it cannot overwrite/dedupe the
    // authoritative accepted-job transition.
    await act(async () => resolveFirst?.(response([])));
    expect(toastMock.success).toHaveBeenCalledTimes(1);
  });

  it('preserves a locally accepted job across a reload before its terminal first snapshot', async () => {
    listMock.mockResolvedValue(response([]));
    const first = render(<JobMonitor actor="analyst.one" onNavigate={vi.fn()} />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    act(() => {
      announceJobAccepted(
        job({
          job_id: 'accepted-before-reload',
          status: 'queued',
          started_at: null,
          finished_at: null,
          result: null,
        }),
      );
    });
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    first.unmount();

    listMock.mockReset().mockResolvedValue(
      response([job({ job_id: 'accepted-before-reload' })]),
    );
    render(<JobMonitor actor="analyst.one" onNavigate={vi.fn()} />);
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));
  });

  it('uses the allowlisted Inbox URL for the primary action', async () => {
    const navigate = vi.fn();
    listMock
      .mockResolvedValueOnce(response([job({ status: 'running', finished_at: null })]))
      .mockResolvedValueOnce(response([job()]));
    getMock.mockResolvedValue({
      items: [{ job_id: 'job-1', url: '#/cases?status=investigating' }],
    });
    const view = render(<JobMonitor actor="analyst.one" onNavigate={navigate} />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    view.unmount();

    // Keep the mounted instance transition-focused by driving a visibility refresh.
    listMock
      .mockReset()
      .mockResolvedValueOnce(response([job({ status: 'running', finished_at: null })]))
      .mockResolvedValueOnce(response([job()]));
    render(<JobMonitor actor="another-actor" onNavigate={navigate} />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));
    const options = toastMock.success.mock.calls[0][1];
    act(() => options.action.onClick());
    expect(navigate).toHaveBeenCalledWith('cases', { status: 'investigating' });
  });

  it('falls back to the active filtered Cases result when a case notification URL is absent', async () => {
    const navigate = vi.fn();
    listMock
      .mockResolvedValueOnce(response([job({ status: 'running', finished_at: null })]))
      .mockResolvedValueOnce(response([job()]));
    render(<JobMonitor actor="fallback-actor" onNavigate={navigate} />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));
    const options = toastMock.success.mock.calls[0][1];
    act(() => options.action.onClick());
    expect(navigate).toHaveBeenCalledWith('cases', { status: 'active' });
  });
});

describe('JobMonitor holds the toast of a job its surface reports itself', () => {
  const exportJob = (overrides: Partial<BackgroundJob> = {}) =>
    job({
      job_id: 'export-1',
      kind: 'audit_export',
      result: { kind: 'audit_export', artifact_id: 'a1', counts: { events: 12 } },
      ...overrides,
    });
  const queued = () => exportJob({ status: 'queued', started_at: null, finished_at: null, result: null });
  const toasts = () => Object.values(toastMock).reduce((n, mock) => n + mock.mock.calls.length, 0);

  beforeEach(() => {
    window.sessionStorage.clear();
    listMock.mockReset();
    getMock.mockReset().mockResolvedValue({ items: [] });
    Object.values(toastMock).forEach((mock) => mock.mockReset());
  });

  async function acceptQuietly() {
    listMock.mockResolvedValueOnce(response([])).mockResolvedValue(response([exportJob()]));
    render(<JobMonitor actor="analyst.one" onNavigate={vi.fn()} />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    act(() => announceJobAccepted(queued(), { quiet: true }));
    // The accepted job ends while the surface still waits for it.
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  }

  it('shows no second notice for a waited export that the dialog downloaded', async () => {
    await acceptQuietly();
    expect(toasts()).toBe(0);
    act(() => releaseJobToast('export-1', { reported: true }));
    // Later refreshes see the same terminal job: still no toast.
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(3));
    expect(toasts()).toBe(0);
  });

  it('shows the held outcome once when the surface stops waiting without reporting it', async () => {
    await acceptQuietly();
    expect(toasts()).toBe(0);
    act(() => releaseJobToast('export-1'));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));
    expect(toastMock.success.mock.calls[0][0]).toBe('Audit export completed');
    expect(toastMock.success.mock.calls[0][1]).toHaveProperty('cancel.label', 'Download');
    // Released twice (a stale call) or refreshed again: still one toast.
    act(() => releaseJobToast('export-1'));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(3));
    expect(toasts()).toBe(1);
  });

  it('toasts as usual when the surface stopped waiting before the job ended', async () => {
    listMock.mockResolvedValue(response([]));
    render(<JobMonitor actor="analyst.one" onNavigate={vi.fn()} />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    listMock.mockResolvedValue(response([queued()]));
    act(() => announceJobAccepted(queued(), { quiet: true }));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    act(() => releaseJobToast('export-1'));
    expect(toasts()).toBe(0);
    listMock.mockResolvedValue(response([exportJob()]));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));
  });

  it('still toasts every job that was not accepted quietly', async () => {
    listMock.mockResolvedValueOnce(response([])).mockResolvedValue(response([exportJob()]));
    render(<JobMonitor actor="analyst.one" onNavigate={vi.fn()} />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    act(() => announceJobAccepted(queued()));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));
  });
});

describe('JobMonitor carries the chat activity frames (SPEC D13)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    listMock.mockReset().mockResolvedValue(response([]));
    getMock.mockReset().mockResolvedValue({ items: [] });
    streamMock.mockClear();
  });
  afterEach(() => {
    setChatFrameSink(null);
  });

  const lastOnEvent = () => {
    const call = streamMock.mock.calls[streamMock.mock.calls.length - 1];
    return call?.[1]?.onEvent as (event: { type: string; data: unknown; lastEventId: string }) => void;
  };

  it('subscribes the caller’s chat turns on its one job stream, with no second stream', async () => {
    render(<JobMonitor actor="analyst.one" onNavigate={vi.fn()} />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    const topics = new Set(streamMock.mock.calls.map((call) => [...call[0]].sort().join(',')));
    expect(topics).toEqual(new Set(['chat,jobs']));
    expect(streamMock.mock.calls.every((call) => call[1]?.enabled === true)).toBe(true);
  });

  it('hands every frame to the chat observer and refreshes jobs for job frames only', async () => {
    const frames: ChatFrame[] = [];
    setChatFrameSink((frame) => frames.push(frame));
    render(<JobMonitor actor="analyst.one" onNavigate={vi.fn()} />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    const turn = { turn_id: 'turn-1', conversation_id: 'c1', case_id: null, phase: 'progress', label: 'Searching logs', lookups: 1, tokens: 10 };
    act(() => lastOnEvent()({ type: 'chat.turn', data: turn, lastEventId: '7' }));
    act(() => lastOnEvent()({ type: 'chat.read', data: { conversation_id: 'c1' }, lastEventId: '' }));
    expect(frames).toEqual([
      expect.objectContaining({ type: 'chat.turn', data: turn }),
      expect.objectContaining({ type: 'chat.read', data: { conversation_id: 'c1' } }),
    ]);
    // A chat step or read is no reason to list jobs again.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(listMock).toHaveBeenCalledTimes(1);
    act(() => lastOnEvent()({ type: 'job', data: { job_id: 'job-1' }, lastEventId: '8' }));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    act(() => lastOnEvent()({ type: 'overflow', data: { dropped: 3 }, lastEventId: '' }));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(3));
    expect(frames.map((frame) => frame.type)).toEqual(['chat.turn', 'chat.read', 'job', 'overflow']);
  });

  it('drops frames quietly while no chat observer has loaded', async () => {
    setChatFrameSink(null);
    render(<JobMonitor actor="analyst.one" onNavigate={vi.fn()} />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    expect(() => act(() => lastOnEvent()({ type: 'chat.turn', data: { turn_id: 'turn-2', phase: 'started' }, lastEventId: '9' }))).not.toThrow();
    expect(listMock).toHaveBeenCalledTimes(1);
  });
});
