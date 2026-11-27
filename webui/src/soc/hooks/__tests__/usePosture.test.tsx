/**
 * usePosture — parameter-keyed, abortable, stale-while-revalidate posture reads.
 *
 *   1. calls fetchPosture with the window hours + no compare by default;
 *   2. period='prev' passes 'prev' so the server returns the compare block;
 *   3. surfaces the resolved payload as data;
 *   4. a window change RETAINS the last successful snapshot (flagged `stale`) while
 *      the new request is in flight, and still discards a late cross-window payload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const { fetchPostureMock } = vi.hoisted(() => ({ fetchPostureMock: vi.fn() }));

vi.mock('@/soc/pages/Metrics.posture.api', async () => {
  const actual = await vi.importActual<typeof import('@/soc/pages/Metrics.posture.api')>(
    '@/soc/pages/Metrics.posture.api',
  );
  return { ...actual, fetchPosture: fetchPostureMock };
});

import { usePosture } from '../usePosture';

describe('usePosture', () => {
  beforeEach(() => {
    fetchPostureMock.mockReset();
    fetchPostureMock.mockImplementation(async (hours: number) => ({
      window_hours: hours,
      case_count: 7,
    }));
  });

  it('fetches for the given window with no compare by default', async () => {
    const { result } = renderHook(() => usePosture(24));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchPostureMock).toHaveBeenCalledWith(24, '', expect.any(AbortSignal));
    expect(result.current.data).toMatchObject({ case_count: 7 });
    expect(result.current.error).toBeNull();
  });

  it("passes 'prev' when period is prev", async () => {
    const { result } = renderHook(() => usePosture(72, 'prev'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchPostureMock).toHaveBeenCalledWith(72, 'prev', expect.any(AbortSignal));
  });

  it('keeps the previous snapshot flagged stale across a window change and discards a delayed cross-window response', async () => {
    const requests: Array<{
      hours: number;
      signal: AbortSignal;
      resolve: (value: unknown) => void;
    }> = [];
    fetchPostureMock.mockImplementation(
      (hours: number, _period: string, signal: AbortSignal) =>
        new Promise((resolve) => requests.push({ hours, signal, resolve })),
    );

    const { result, rerender } = renderHook(
      ({ hours }) => usePosture(hours, 'prev'),
      { initialProps: { hours: 24 } },
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    // Nothing has succeeded yet — there is no snapshot to retain.
    expect(result.current.data).toBeNull();
    expect(result.current.stale).toBe(false);

    await act(async () => {
      requests[0].resolve({
        window_hours: 24,
        quality: { false_positive_rate: 0.48, auto_closed_cases: 25 },
      });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.window_hours).toBe(24);
    expect(result.current.stale).toBe(false);

    // STALE-WHILE-REVALIDATE: the window change keeps the 24h snapshot mounted,
    // synchronously flagged stale + loading, instead of nulling it (no blanking).
    rerender({ hours: 168 });
    expect(result.current.data?.window_hours).toBe(24);
    expect(result.current.stale).toBe(true);
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].hours).toBe(168);

    await act(async () => {
      requests[1].resolve({
        window_hours: 168,
        quality: { false_positive_rate: 0.83, auto_closed_cases: 1355 },
      });
    });
    await waitFor(() =>
      expect(result.current.data).toMatchObject({
        window_hours: 168,
        quality: { false_positive_rate: 0.83, auto_closed_cases: 1355 },
      }),
    );
    // The fresh payload clears the stale flag atomically.
    expect(result.current.stale).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('discards a delayed cross-window response after the fresh payload landed', async () => {
    const requests: Array<{
      hours: number;
      signal: AbortSignal;
      resolve: (value: unknown) => void;
    }> = [];
    fetchPostureMock.mockImplementation(
      (hours: number, _period: string, signal: AbortSignal) =>
        new Promise((resolve) => requests.push({ hours, signal, resolve })),
    );

    const { result, rerender } = renderHook(
      ({ hours }) => usePosture(hours, 'prev'),
      { initialProps: { hours: 24 } },
    );
    await waitFor(() => expect(requests).toHaveLength(1));

    rerender({ hours: 168 });
    await waitFor(() => expect(requests).toHaveLength(2));

    await act(async () => {
      requests[1].resolve({
        window_hours: 168,
        quality: { false_positive_rate: 0.83, auto_closed_cases: 1355 },
      });
    });
    await waitFor(() => expect(result.current.data?.window_hours).toBe(168));

    // A transport/mock may still settle after abort. The parameter key, not timing,
    // remains the final authority — the late 24h payload never overwrites 168h.
    await act(async () => {
      requests[0].resolve({
        window_hours: 24,
        quality: { false_positive_rate: 0.48, auto_closed_cases: 25 },
      });
    });
    expect(result.current.data?.window_hours).toBe(168);
    expect(result.current.data?.quality.false_positive_rate).toBe(0.83);
    expect(result.current.stale).toBe(false);
  });

  it('makes a retained LIVE reload callback issue the latest range during rapid churn', async () => {
    const requests: Array<{
      hours: number;
      signal: AbortSignal;
      resolve: (value: unknown) => void;
    }> = [];
    fetchPostureMock.mockImplementation(
      (hours: number, _period: string, signal: AbortSignal) =>
        new Promise((resolve) => requests.push({ hours, signal, resolve })),
    );
    const { result, rerender } = renderHook(
      ({ hours }) => usePosture(hours, 'prev'),
      { initialProps: { hours: 24 } },
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    const retainedLiveReload = result.current.reload;

    rerender({ hours: 168 });
    rerender({ hours: 24 });
    rerender({ hours: 720 });
    await waitFor(() => expect(requests.at(-1)?.hours).toBe(720));

    await act(async () => {
      void retainedLiveReload();
    });
    await waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(3));
    expect(requests.at(-1)?.hours).toBe(720);

    const latest = requests.at(-1)!;
    await act(async () => {
      latest.resolve({ window_hours: 720, quality: { false_positive_rate: 0.61 } });
    });
    await waitFor(() => expect(result.current.data?.window_hours).toBe(720));
    expect(requests.filter((request) => !request.signal.aborted)).toHaveLength(1);
  });

  it('rejects a payload whose echoed window does not match the issued parameters', async () => {
    fetchPostureMock.mockResolvedValue({ window_hours: 24, case_count: 7 });
    const { result } = renderHook(() => usePosture(168, 'prev'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeInstanceOf(Error);
  });
});
