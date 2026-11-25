/**
 * B53 (Round 16 SPEC §4.5 WP15E): the Inbox Preferences sheet is wide enough for the
 * whole routing matrix. At `size="lg"` (672 px) the eight-column table needed a hidden
 * sideways scroll and the Telegram column read "Telegra". The sheet is `size="xl"`
 * (896 px), and the channel headers stay on one line.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { listMock, getPrefsMock } = vi.hoisted(() => ({ listMock: vi.fn(), getPrefsMock: vi.fn() }));

vi.mock('@/soc/pages/Inbox.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../Inbox.api')>();
  return {
    ...actual,
    inboxApi: {
      list: listMock,
      unreadCount: vi.fn().mockResolvedValue({ unread: 0 }),
      markRead: vi.fn(),
      markAllRead: vi.fn(),
      dismiss: vi.fn(),
      getPrefs: getPrefsMock,
      putPrefs: vi.fn(),
    },
  };
});

import { TooltipProvider } from '@/ui/tooltip';
import Inbox from '../Inbox';

beforeEach(() => {
  listMock.mockReset().mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
  getPrefsMock.mockReset().mockResolvedValue({ categories: {}, digest: 'off', channels_configured: {} });
});

describe('B53: the Preferences sheet fits the routing matrix', () => {
  it('opens at the xl size with one-line channel headers', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <Inbox onNavigate={vi.fn()} />
      </TooltipProvider>,
    );
    await user.click(await screen.findByRole('button', { name: /preferences/i }));
    const sheet = await screen.findByRole('dialog', { name: 'Notification preferences' });
    expect(sheet.className).toContain('max-w-[56rem]');
    expect(sheet.className).not.toContain('max-w-2xl');
    const table = await within(sheet).findByRole('table', { name: 'Notification routing matrix' });
    for (const name of ['In-app', 'Telegram']) {
      expect(within(table).getByRole('columnheader', { name })).toHaveClass('whitespace-nowrap');
    }
  });
});
