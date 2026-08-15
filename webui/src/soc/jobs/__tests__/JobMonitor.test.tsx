import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

import type { BackgroundJob } from '@/lib/types';

const { listMock, getMock, toastMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  getMock: vi.fn(),
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
  useEventStream: () => ({ live: false }),
}));
vi.mock('sonner', () => ({ toast: toastMock }));

import { announceJobAccepted } from '../jobs';
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
