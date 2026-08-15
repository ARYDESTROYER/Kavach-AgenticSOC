/** The posture data layer must preserve the caller's cancellation signal. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/lib/api', () => ({
  API_BASE: '/api',
  api: { get: getMock },
}));

import { fetchPosture } from '../Metrics.posture.api';

describe('fetchPosture cancellation contract', () => {
  beforeEach(() => {
    getMock.mockReset().mockResolvedValue({ window_hours: 168 });
  });

  it('forwards the exact AbortSignal with the requested parameter key', async () => {
    const controller = new AbortController();

    await fetchPosture(168, 'prev', controller.signal);

    expect(getMock).toHaveBeenCalledWith(
      'metrics/posture',
      { window_hours: 168, compare: 'prev' },
      controller.signal,
    );
  });
});
