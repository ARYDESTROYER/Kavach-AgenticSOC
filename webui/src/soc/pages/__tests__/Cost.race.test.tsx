/**
 * Cost: the Round-6 window-switch fetch-race guard.
 *
 * Switching the time range fires a fresh /usage/summary request. Only the
 * LATEST-issued request may commit, so a slow earlier range can never clobber the
 * current one. We drive two overlapping requests and resolve them out of order.
 *
 * Round 14: the range is the page header's Overview pill (the Analytics ranges, last 7
 * days by default), and the refresh is the header's icon button.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/soc/demo', () => ({ useDemo: () => ({ active: false }) }));

type Deferred = { resolve: (v: unknown) => void };
const pending = new Map<number, Deferred>();
const usageSummary = vi.fn(
  (hours: number) => new Promise((resolve) => pending.set(hours, { resolve })),
);

vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  api: { usageSummary: (h: number) => usageSummary(h) },
}));

import Cost from '../Cost';
import { resetAnalyticsWindow } from '../analytics-shared';

const summary = (total: number) => ({
  total_cost: total,
  call_count: 3,
  currency: 'USD',
  total_tokens: 0,
  today_cost: 0,
});

describe('Cost window-switch race', () => {
  beforeEach(() => {
    resetAnalyticsWindow();
    pending.clear();
    usageSummary.mockClear();
  });

  it('ignores a stale earlier-window response that resolves last', async () => {
    render(<Cost />);

    // The initial 7-day load is in flight.
    await waitFor(() => expect(pending.has(168)).toBe(true));
    expect(screen.getByRole('status', { name: 'Loading cost data' })).toBeInTheDocument();

    // Switch the range to the last 24 hours: a second request is issued.
    await userEvent.click(screen.getByRole('button', { name: 'Time range: Last 7 days' }));
    const ranges = await screen.findByRole('group', { name: 'Relative time ranges' });
    await userEvent.click(within(ranges).getByRole('button', { name: /^Last 24 hours/ }));
    await waitFor(() => expect(pending.has(24)).toBe(true));

    // Resolve the LATEST (24h) request first; its total should render.
    pending.get(24)!.resolve(summary(99));
    await waitFor(() => expect(screen.getAllByText('$99.00').length).toBeGreaterThan(0));

    // Now the STALE 7-day request resolves: it must NOT clobber the 24h view.
    pending.get(168)!.resolve(summary(1));
    await waitFor(() => expect(usageSummary).toHaveBeenCalledTimes(2));

    expect(screen.getAllByText('$99.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('$1.00')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Time range: Last 24 hours' })).toBeInTheDocument();
  });

  it('keeps resolved cost data mounted during a manual refresh', async () => {
    render(<Cost />);
    await waitFor(() => expect(pending.has(168)).toBe(true));

    pending.get(168)!.resolve(summary(12));
    await waitFor(() => expect(screen.getAllByText('$12.00').length).toBeGreaterThan(0));

    await userEvent.click(screen.getByRole('button', { name: 'Refresh usage' }));
    await waitFor(() => expect(usageSummary).toHaveBeenCalledTimes(2));

    expect(screen.getAllByText('$12.00').length).toBeGreaterThan(0);
    expect(screen.queryByRole('status', { name: 'Loading cost data' })).toBeNull();

    pending.get(168)!.resolve(summary(13));
    await waitFor(() => expect(screen.getAllByText('$13.00').length).toBeGreaterThan(0));
  });
});
