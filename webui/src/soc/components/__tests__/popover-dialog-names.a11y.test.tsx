/**
 * Popover dialogs say which panel they are (Round 16 bug hunt B75, WP15F).
 *
 * Radix renders popover content as `role="dialog"`; without a name a screen reader announces
 * just "dialog" (axe aria-dialog-name, serious). The source guard
 * (`soc/__tests__/popover-names.guard.test.ts`) holds every popover to a name; this opens the
 * ones the bug hunt met in the browser and asks axe.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

const { fetchInboxMock } = vi.hoisted(() => ({ fetchInboxMock: vi.fn() }));

vi.mock('../NotificationBell.api', () => ({
  fetchInbox: fetchInboxMock,
  fetchUnreadCount: vi.fn().mockResolvedValue({ unread: 0 }),
  fetchActiveJobCount: vi.fn().mockResolvedValue(0),
  markAllRead: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/useEventStream', () => ({
  useEventStream: vi.fn(() => ({ live: false })),
}));

import { NotificationBell } from '../NotificationBell';
import { TimeRangePicker } from '../TimeRangePicker';

async function expectNamedDialog(name: string) {
  const dialog = await screen.findByRole('dialog', { name });
  const results = await act(() => axe(dialog, { runOnly: { type: 'rule', values: ['aria-dialog-name'] } }));
  expect(results).toHaveNoViolations();
}

describe('popover dialogs carry a name (B75)', () => {
  beforeEach(() => {
    fetchInboxMock.mockReset().mockResolvedValue({ items: [] });
  });

  it('the notification bell', async () => {
    render(<NotificationBell onNavigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: /notifications/i }));
    await expectNamedDialog('Notifications');
  });

  it('the time range picker', async () => {
    render(<TimeRangePicker value={{ from: 'now-24h', to: 'now', label: 'Last 24 hours' }} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /time range/i }));
    await expectNamedDialog('Time range');
  });
});
