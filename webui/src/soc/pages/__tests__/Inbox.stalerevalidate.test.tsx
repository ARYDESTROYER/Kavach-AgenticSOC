/**
 * Inbox — stale-while-revalidate reloads + request-sequence guard
 * (Round 6 admin-misc, findings #35 / #36).
 *
 * #36: a Refresh / filter-toggle reload set `loading=true`, which replaced the whole
 *      list with skeleton rows on every routine reload. FIX: keep the current items
 *      on screen during a reload (only the FIRST load, with no items, shows skeletons).
 * #35: the resolve path wrote state unconditionally, so a slow earlier response could
 *      clobber a newer one. FIX: a monotonic seqRef ignores superseded responses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { listMock, markAllReadMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  markAllReadMock: vi.fn(),
}));

vi.mock('@/soc/pages/Inbox.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../Inbox.api')>();
  return {
    ...actual,
    inboxApi: {
      list: listMock,
      unreadCount: vi.fn().mockResolvedValue({ unread: 0 }),
      markRead: vi.fn().mockResolvedValue({ ok: true }),
      markAllRead: markAllReadMock,
      dismiss: vi.fn().mockResolvedValue({ ok: true, dismissed: true }),
      getPrefs: vi.fn(),
      putPrefs: vi.fn(),
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { TooltipProvider } from '@/ui/tooltip';
import Inbox from '../Inbox';

const ITEM = (id: string, title: string) => ({
  id,
  category: 'assignment',
  title,
  body: 'body',
  state: 'read' as const,
  created_at: '2026-06-30T10:00:00Z',
});

function renderInbox() {
  return render(
    <TooltipProvider>
      <Inbox onNavigate={vi.fn()} />
    </TooltipProvider>,
  );
}

describe('Inbox stale-while-revalidate (findings #35/#36)', () => {
  beforeEach(() => {
    listMock.mockReset();
    markAllReadMock.mockReset();
  });

  it('keeps the current items visible during a Refresh reload (no skeleton flash)', async () => {
    listMock.mockResolvedValue({ items: [ITEM('n1', 'First note')], total: 1 });
    renderInbox();
    await screen.findByText('First note');

    // The next reload never resolves → loading stays true while it is in flight.
    let resolveSecond: (v: unknown) => void = () => {};
    listMock.mockImplementationOnce(
      () => new Promise((res) => { resolveSecond = res; }),
    );

    const refreshButton = screen.getByRole('button', { name: /^refresh inbox$/i });
    fireEvent.click(refreshButton);

    // The existing item is STILL on screen (stale-while-revalidate), not torn down to
    // skeletons — the row survives an in-flight reload.
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText('First note')).toBeInTheDocument();

    resolveSecond({ items: [ITEM('n1', 'First note')], total: 1 });
    await waitFor(() => expect(refreshButton).toBeEnabled());
  });

  it('ignores a superseded (out-of-order) response via the sequence guard', async () => {
    // First load resolves immediately with the initial item.
    listMock.mockResolvedValueOnce({ items: [ITEM('n1', 'Initial')], total: 1 });
    renderInbox();
    await screen.findByText('Initial');

    // Kick off TWO overlapping reloads via the (never-disabled) Unread/All toggle: an
    // earlier SLOW one and a later FAST one. The later (newest) request wins; the
    // earlier response, resolving last, must be ignored by the seq guard.
    let resolveSlow: (v: unknown) => void = () => {};
    listMock.mockImplementationOnce(
      () => new Promise((res) => { resolveSlow = res; }),
    );
    listMock.mockResolvedValueOnce({ items: [ITEM('n2', 'Newest')], total: 1 });

    fireEvent.click(screen.getByRole('radio', { name: /^unread$/i })); // → unread (seq N, slow)
    fireEvent.click(screen.getByRole('radio', { name: /^all$/i })); // → all (seq N+1, fast)

    await screen.findByText('Newest');

    // Now the earlier slow request resolves with STALE data — it must be ignored.
    resolveSlow({ items: [ITEM('n1', 'Stale wins?'), ITEM('n3', 'Also stale')], total: 2 });

    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(3));
    expect(screen.getByText('Newest')).toBeInTheDocument();
    expect(screen.queryByText('Stale wins?')).not.toBeInTheDocument();
  });
});
