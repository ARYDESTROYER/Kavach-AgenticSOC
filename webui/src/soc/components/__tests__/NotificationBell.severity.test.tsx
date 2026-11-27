/**
 * NotificationBell — severity redundancy + token (Round 6 admin-misc, #29 / #30).
 *
 * #29: the dropdown row conveyed severity by a color-only dot (aria-hidden, WCAG
 *      1.4.1). FIX: for a known severity it renders the shared SEMANTIC_ICON glyph
 *      (shape = colorblind-safe) + an sr-only "<sev> severity" label for AT.
 * #30: the unread badge used a hardcoded `text-white`. FIX: the paired
 *      `text-critical-foreground` token (so it tracks the critical axis in both themes).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fetchInboxMock, fetchActiveJobCountMock, eventStreamMock } = vi.hoisted(() => ({
  fetchInboxMock: vi.fn(),
  fetchActiveJobCountMock: vi.fn().mockResolvedValue(0),
  eventStreamMock: vi.fn(() => ({ live: false })),
}));

vi.mock('../NotificationBell.api', () => ({
  fetchInbox: fetchInboxMock,
  fetchUnreadCount: vi.fn().mockResolvedValue({ unread: 1 }),
  fetchActiveJobCount: fetchActiveJobCountMock,
  markAllRead: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/useEventStream', () => ({
  useEventStream: eventStreamMock,
}));

import { NotificationBell } from '../NotificationBell';

describe('NotificationBell severity a11y (#29) + badge token (#30)', () => {
  beforeEach(() => {
    fetchInboxMock.mockReset();
    fetchActiveJobCountMock.mockReset().mockResolvedValue(0);
    eventStreamMock.mockClear();
    fetchInboxMock.mockResolvedValue({
      items: [
        {
          id: 'n1',
          title: 'Case escalated',
          body: 'risk 82',
          severity: 'high',
          state: 'read',
          created_at: '2026-06-30T10:00:00Z',
        },
      ],
    });
  });

  it('keeps active background work visible even when its Inbox item is read', async () => {
    fetchActiveJobCountMock.mockResolvedValue(2);
    render(<NotificationBell onNavigate={vi.fn()} />);
    expect(
      await screen.findByRole('button', {
        name: /1 unread, 2 active jobs/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByTitle('2 active background jobs')).toHaveTextContent('2');
  });

  it('subscribes to jobs and renders durable progress in the recent window', async () => {
    fetchInboxMock.mockResolvedValueOnce({
      items: [
        {
          id: 'job-notification',
          title: 'Export running',
          body: 'Building one ZIP',
          state: 'read',
          created_at: '2026-08-13T10:00:00Z',
          job_id: 'job-1',
          job_status: 'running',
          progress: { done: 3, total: 6, unit: 'scopes' },
          result: null,
        },
      ],
    });
    render(<NotificationBell onNavigate={vi.fn()} />);
    expect(eventStreamMock).toHaveBeenCalledWith(
      expect.arrayContaining(['notifications', 'inbox', 'jobs']),
      expect.any(Object),
    );

    await userEvent.click(screen.getByRole('button', { name: /notifications/i }));
    expect(await screen.findByRole('status', { name: '3 of 6 scopes complete' })).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('announces severity beside the color (not color-only) + uses the critical token badge', async () => {
    render(<NotificationBell onNavigate={vi.fn()} />);

    // The unread badge uses the paired on-color token, not a hardcoded text-white.
    const badge = await screen.findByText('1');
    expect(badge.className).toContain('text-critical-foreground');
    expect(badge.className).not.toContain('text-white');

    // Open the dropdown and load the recent window.
    await userEvent.click(screen.getByRole('button', { name: /notifications/i }));
    await waitFor(() => expect(fetchInboxMock).toHaveBeenCalled());

    // Severity is announced to AT via an sr-only label (WCAG 1.4.1 redundancy).
    expect(await screen.findByText('high severity')).toBeInTheDocument();
  });

  it('uses the shared named loader while the inbox window opens', async () => {
    let resolveInbox!: (value: { items: [] }) => void;
    fetchInboxMock.mockImplementationOnce(
      () => new Promise<{ items: [] }>((resolve) => { resolveInbox = resolve; }),
    );

    render(<NotificationBell onNavigate={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /notifications/i }));

    expect(
      await screen.findByRole('status', { name: 'Loading notifications' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('console-loading-glyph')).toBeInTheDocument();

    resolveInbox({ items: [] });
    expect(await screen.findByText('You’re all caught up')).toBeInTheDocument();
  });

  it('ignores an older recent-window response that resolves after newer job progress', async () => {
    render(<NotificationBell onNavigate={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /notifications/i }));
    await screen.findByText('Case escalated');

    let resolveSlow!: (value: { items: Array<{ id: string; title: string; state: 'read' }> }) => void;
    fetchInboxMock
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveSlow = resolve;
        }),
      )
      .mockResolvedValueOnce({
        items: [{ id: 'new', title: 'Newest progress', state: 'read' }],
      });
    const onEvent = eventStreamMock.mock.calls.at(-1)?.[1]?.onEvent as (() => void) | undefined;
    expect(onEvent).toBeTypeOf('function');
    act(() => {
      onEvent?.();
      onEvent?.();
    });

    expect(await screen.findByText('Newest progress')).toBeInTheDocument();
    await act(async () => {
      resolveSlow({ items: [{ id: 'stale', title: 'Stale progress', state: 'read' }] });
    });
    expect(screen.getByText('Newest progress')).toBeInTheDocument();
    expect(screen.queryByText('Stale progress')).not.toBeInTheDocument();
  });
});
