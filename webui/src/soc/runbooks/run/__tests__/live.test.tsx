/**
 * The queue chips' live frames (Round 14, SPEC §4.10.15): the server serves the `runbooks`
 * topic only with both `runbooks:read` and `cases:read` and drops it silently otherwise,
 * so the chips read their progress on `cases:read` but open no stream for a viewer
 * without `runbooks:read` (a stream that never delivers a frame still holds one of the
 * browser's few connections per origin).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { useEventStream, getRunbookProgress } = vi.hoisted(() => ({
  useEventStream: vi.fn((_topics: string[], _opts: { enabled?: boolean }) => ({ live: false })),
  getRunbookProgress: vi.fn(),
}));

vi.mock('@/lib/useEventStream', () => ({ useEventStream }));
vi.mock('@/lib/api-runbooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-runbooks')>();
  return { ...actual, getRunbookProgress };
});

import { RUNBOOKS_TOPIC, resetRunbookLiveForTests, useRunbookProgressMap } from '../live';
import { progress } from './fixtures';

/** Whether any render asked for the runbooks stream to be open. */
function streamOpened(): boolean {
  return useEventStream.mock.calls.some(([topics, opts]) => topics.includes(RUNBOOKS_TOPIC) && opts?.enabled === true);
}

beforeEach(() => {
  resetRunbookLiveForTests();
  useEventStream.mockClear();
  getRunbookProgress.mockReset().mockResolvedValue({ 'case-1': progress() });
});

afterEach(() => resetRunbookLiveForTests());

describe('queue chips', () => {
  it('read progress but open no runbook stream without runbooks:read', async () => {
    const { result } = renderHook(() => useRunbookProgressMap(['case-1'], { enabled: true, live: false }));
    await waitFor(() => expect(result.current['case-1']).toMatchObject({ total: 6 }));
    expect(streamOpened()).toBe(false);
  });

  it('open the one runbook stream with runbooks:read', async () => {
    const { result } = renderHook(() => useRunbookProgressMap(['case-1'], { enabled: true, live: true }));
    await waitFor(() => expect(result.current['case-1']).toMatchObject({ total: 6 }));
    expect(streamOpened()).toBe(true);
  });
});
