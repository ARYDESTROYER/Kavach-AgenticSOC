/**
 * Wave 4 / F5: the Alerting & Notifications editor and HelpTip (Round 14: grouped panels).
 *
 * Verifies the NotificationsEditor renders the master switch + a configured channel,
 * surfaces the email provider presets it fetches, and that adding/removing channels
 * flows through the `update` callback (config edits; secrets are pushed separately).
 * The api surface is mocked so no network is touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => ({
  api: {
    notifications: {
      providers: vi.fn().mockResolvedValue({
        email_presets: [
          { id: 'gmail', host: 'smtp.gmail.com', port: 587, security: 'starttls', username_hint: 'app password' },
          { id: 'custom', host: '', port: 0, security: 'starttls', username_hint: '' },
        ],
        channel_types: ['email', 'slack', 'teams', 'webhook', 'pagerduty', 'telegram'],
      }),
      test: vi.fn().mockResolvedValue({ ok: true, detail: 'ok' }),
      channelSecret: vi.fn().mockResolvedValue({ ok: true, configured: true, configured_secrets: ['secret'] }),
    },
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn(), warning: vi.fn() } }));

import { NotificationsEditor } from '../components/NotificationsEditor';
import { HelpTip } from '../components/HelpTip';
import { TooltipProvider } from '@/ui/tooltip';
import type { Preferences } from '@/lib/types';

async function setup(prefsOver: Partial<Preferences> = {}) {
  const update = vi.fn();
  const prefs = { ...prefsOver } as Preferences;
  // The shared SecretField's reveal IconButton renders a Tooltip; the app supplies ONE
  // root TooltipProvider, so the test harness must too.
  const utils = render(
    <TooltipProvider>
      <NotificationsEditor prefs={prefs} update={update} />
    </TooltipProvider>,
  );
  // NotificationsEditor loads provider metadata after mount. Keep that real promise-
  // driven rerender inside React's interaction boundary before a test asserts or exits;
  // otherwise Radix Select/Slider ref registration is still settling during cleanup.
  await act(async () => {
    await Promise.resolve();
  });
  return { update, ...utils };
}

describe('NotificationsEditor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the master enable switch and empty channels state', async () => {
    await setup({ notifications: { enabled: false, channels: [] } });
    expect(
      screen.getByRole('heading', { name: 'Alerting & notifications', level: 2 }),
    ).toBeInTheDocument();
    // Round 14 (SPEC §4.9.6): the master switch is a setting row on a group panel.
    const switchRow = screen.getByLabelText('Notifications enabled').closest('[data-setting-row="switch"]');
    expect(switchRow).not.toBeNull();
    expect(switchRow?.closest('[data-settings-panel]')).not.toBeNull();
    expect(switchRow?.className).not.toMatch(/rounded|shadow|bg-card|bg-surface/);
    expect(screen.getByText(/No channels yet/i)).toBeInTheDocument();
  });

  it('toggling the master switch calls update with notifications.enabled', async () => {
    const user = userEvent.setup();
    const { update } = await setup({ notifications: { enabled: false, channels: [] } });
    const sw = screen.getByLabelText('Notifications enabled');
    await user.click(sw);
    expect(update).toHaveBeenCalled();
    const arg = update.mock.calls[0][0];
    expect(arg.notifications.enabled).toBe(true);
  });

  it('renders a configured email channel with its name and recipient summary', async () => {
    await setup({
      notifications: {
        enabled: true,
        channels: [
          {
            id: 'email-1',
            type: 'email',
            enabled: true,
            name: 'Ops mailbox',
            config: { provider: 'gmail', from_addr: 'a@x.com', recipients: ['a@x.com', 'b@x.com'] },
            configured_secrets: ['secret'],
          },
        ],
      },
    });
    expect(screen.getByDisplayValue('Ops mailbox')).toBeInTheDocument();
    const channel = screen.getByDisplayValue('Ops mailbox').closest('[data-settings-editor="notification-channel"]');
    // A channel is a row on the Channels panel, not a box inside it.
    expect(channel?.closest('[data-setting-row="block"]')?.closest('[data-settings-panel]')).not.toBeNull();
    expect(channel?.className).not.toMatch(/rounded|shadow|bg-card|border/);
    expect(screen.getByText(/2 recipient\(s\)/)).toBeInTheDocument();
    // configured secret badge present
    expect(screen.getAllByText(/Configured/i).length).toBeGreaterThan(0);
  });

  it('shows trigger switches', async () => {
    await setup({ notifications: { enabled: true, channels: [], triggers: { on_escalated: true } } });
    expect(screen.getByText('On escalated')).toBeInTheDocument();
    expect(screen.getByText('On true positive')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'On escalated' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'On true positive' })).toHaveAttribute('aria-checked', 'false');
  });

  it('writes a trigger switch through update, keeping the other triggers', async () => {
    const user = userEvent.setup();
    const { update } = await setup({ notifications: { enabled: true, channels: [], triggers: { on_escalated: true } } });
    await user.click(screen.getByRole('switch', { name: 'On needs human' }));
    expect(update).toHaveBeenCalledWith({
      notifications: expect.objectContaining({
        triggers: expect.objectContaining({ on_escalated: true, on_needs_human: true }),
      }),
    });
  });

  it('lays the section out as titled groups, each on one panel, in sentence case', async () => {
    const { container } = await setup({ notifications: { enabled: true, channels: [] } });
    const titles = Array.from(container.querySelectorAll('[data-settings-group] h3')).map((h) => h.textContent);
    expect(titles).toEqual(['Notifications', 'Channels', 'Email templates', 'Triggers', 'Delivery controls']);
    expect(container.innerHTML).not.toMatch(/uppercase|tracking-wider/);
    expect(container.textContent ?? '').not.toContain('\u2014');
  });

  it('states notifications off in words under the master switch, never by dimming the editable groups', async () => {
    const { container, rerender } = await setup({ notifications: { enabled: false, channels: [] } });
    const body = container.querySelector('[data-notifications-active]');
    expect(body).toHaveAttribute('data-notifications-active', 'false');
    // The groups stay editable, so they stay at full contrast (WCAG 1.4.3).
    for (let node = body as HTMLElement | null; node && node !== container; node = node.parentElement) {
      expect(node.className).not.toMatch(/opacity-/);
    }
    // No group below the switch is dimmed either (an icon may still use opacity itself).
    container.querySelectorAll<HTMLElement>('[data-settings-group]').forEach((group) => {
      expect(group.className).not.toMatch(/opacity-/);
    });
    const callout = screen.getByTestId('notifications-off-callout');
    expect(callout).toHaveTextContent('Notifications are off. Nothing is sent until you turn them on.');
    expect(callout).toHaveAttribute('role', 'status');
    // The notice sits in the master switch's own group, under the switch.
    const masterGroup = screen.getByRole('switch', { name: 'Notifications enabled' }).closest('[data-settings-group]');
    expect(masterGroup?.contains(callout)).toBe(true);
    rerender(
      <TooltipProvider>
        <NotificationsEditor prefs={{ notifications: { enabled: true, channels: [] } } as Preferences} update={vi.fn()} />
      </TooltipProvider>,
    );
    expect(container.querySelector('[data-notifications-active]')).toHaveAttribute('data-notifications-active', 'true');
    expect(screen.queryByTestId('notifications-off-callout')).toBeNull();
  });

  it('keeps the form groups on the 44rem measure and lets only the email templates span the width', async () => {
    const { container } = await setup({ notifications: { enabled: true, channels: [] } });
    const groups = Array.from(container.querySelectorAll<HTMLElement>('[data-settings-group]'));
    const byTitle = new Map(groups.map((g) => [g.querySelector('h3')?.textContent ?? '', g]));
    for (const title of ['Notifications', 'Channels', 'Triggers', 'Delivery controls']) {
      expect(byTitle.get(title)?.className).toContain('max-w-[44rem]');
    }
    expect(byTitle.get('Email templates')?.className ?? '').not.toContain('max-w-[44rem]');
  });

  it('returns focus to Add channel when the add dialog closes (SPEC §3.3)', async () => {
    await setup({ notifications: { enabled: true, channels: [] } });
    const add = screen.getByRole('button', { name: 'Add channel' });
    add.focus();
    fireEvent.click(add);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(add));
  });

  it('edits the delivery numbers through NumberFields with their units inside', async () => {
    const { update } = await setup({ notifications: { enabled: true, channels: [], dedup_window_seconds: 300 } });
    const dedup = screen.getByRole('spinbutton', { name: /dedup window/i });
    expect(dedup).toHaveAttribute('aria-valuetext', expect.stringContaining('s'));
    expect(document.querySelector('input[type="number"]')).toBeNull();
    await act(async () => {
      fireEvent.change(dedup, { target: { value: '600' } });
      fireEvent.blur(dedup);
    });
    expect(update).toHaveBeenCalledWith({
      notifications: expect.objectContaining({ dedup_window_seconds: 600 }),
    });
  });
});

describe('HelpTip', () => {
  it('renders an accessible trigger button', () => {
    render(<HelpTip text="A short hint" label="Hint help" />);
    expect(screen.getByLabelText('Hint help')).toBeInTheDocument();
  });

  it('shows a popover for longer help with a link', async () => {
    const user = userEvent.setup();
    render(<HelpTip text="x" link="https://example.com" label="Link help" />);
    const btn = screen.getByLabelText('Link help');
    await user.click(btn);
    await waitFor(() => expect(screen.getByText(/Learn more/i)).toBeInTheDocument());
  });
});
