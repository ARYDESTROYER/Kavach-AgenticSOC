/**
 * NotificationBell — the pinned Agent-health section (Round-12).
 *
 * The Cyber Defence Center's `role="alert"` warning strip was retired; its state now
 * reaches the operator through the bell, from every route rather than only the dashboard.
 * The contract this pins:
 *
 *   - the bell stays PROVIDER-FREE. It renders here with no `<AuthProvider>` (as the
 *     sibling severity spec already does), which is exactly why the degradations arrive as
 *     a prop instead of the bell calling `useHealthDiagnosticsData` itself.
 *   - the section is PINNED — a sibling of the inbox `ScrollArea`, never a descendant of
 *     it — so a degradation can never scroll away behind the notification list.
 *   - the trigger's `aria-label` carries the state, because every badge is `aria-hidden`.
 *   - the header states the FIXED 24h window the shell reads (the shell has no operator
 *     time range, and the auto-close verdict is window-scoped).
 *   - backend-supplied label/detail render as PLAIN text (#9) — never into an href/src.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fetchInboxMock, fetchActiveJobCountMock } = vi.hoisted(() => ({
  fetchInboxMock: vi.fn(),
  fetchActiveJobCountMock: vi.fn().mockResolvedValue(0),
}));

vi.mock('../NotificationBell.api', () => ({
  fetchInbox: fetchInboxMock,
  fetchUnreadCount: vi.fn().mockResolvedValue({ unread: 0 }),
  fetchActiveJobCount: fetchActiveJobCountMock,
  markAllRead: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/useEventStream', () => ({
  useEventStream: vi.fn(() => ({ live: false })),
}));

import type { HealthDegradation } from '../health-diagnostics-state';
import { NotificationBell } from '../NotificationBell';

const DEGRADED: HealthDegradation[] = [
  {
    id: 'sql_schema_migration_failed',
    label: 'State-schema migration failed',
    severity: 'critical',
    detail: 'pgvector extension is not installed',
    remediation: 'Install pgvector and restart the backend.',
  },
  {
    id: 'auto_close_degraded',
    label: 'Auto-close rate is outside tolerance',
    severity: 'warning',
    detail: '',
    remediation: '',
  },
];

describe('NotificationBell — Agent health', () => {
  beforeEach(() => {
    fetchInboxMock.mockReset().mockResolvedValue({ items: [] });
    fetchActiveJobCountMock.mockReset().mockResolvedValue(0);
  });

  it('renders no health surface at all when nothing is degraded', async () => {
    render(<NotificationBell onNavigate={vi.fn()} />);

    const trigger = await screen.findByRole('button', { name: /notifications/i });
    expect(trigger.getAttribute('aria-label')).not.toMatch(/agent health/i);
    expect(screen.queryByTestId('notification-bell-health-marker')).toBeNull();

    await userEvent.click(trigger);
    expect(screen.queryByTestId('health-degradation-section')).toBeNull();
  });

  it('marks the trigger and names the state in its accessible label', async () => {
    render(<NotificationBell onNavigate={vi.fn()} healthDegradations={DEGRADED} />);

    const trigger = await screen.findByRole('button', {
      name: /agent health needs attention/i,
    });
    // The marker itself is aria-hidden — the label above is the ONLY thing a screen
    // reader gets, which is why the label assertion is the load-bearing one.
    const marker = screen.getByTestId('notification-bell-health-marker');
    expect(marker).toHaveAttribute('aria-hidden');
    expect(trigger).toContainElement(marker);
  });

  it('pins the section OUTSIDE the inbox scroller and names the window', async () => {
    render(<NotificationBell onNavigate={vi.fn()} healthDegradations={DEGRADED} />);
    await userEvent.click(await screen.findByRole('button', { name: /notifications/i }));

    const section = await screen.findByTestId('health-degradation-section');
    expect(section).toHaveTextContent('Agent health · last 24 hours');

    // The scroll port is Radix's ScrollArea viewport; the section must not be inside it.
    const viewport = document.querySelector('[data-radix-scroll-area-viewport]');
    expect(viewport).not.toBeNull();
    expect(viewport?.contains(section)).toBe(false);
  });

  it('lists every degradation as plain text with a shape, not colour alone', async () => {
    render(<NotificationBell onNavigate={vi.fn()} healthDegradations={DEGRADED} />);
    await userEvent.click(await screen.findByRole('button', { name: /notifications/i }));

    const section = await screen.findByTestId('health-degradation-section');
    expect(section).toHaveTextContent('State-schema migration failed');
    expect(section).toHaveTextContent('pgvector extension is not installed');
    expect(section).toHaveTextContent('Auto-close rate is outside tolerance');
    // WCAG 1.4.1 redundancy: the severity word is spoken, not implied by the tint.
    expect(within(section).getByText(/^Critical:/)).toBeInTheDocument();
    expect(within(section).getByText(/^Warning:/)).toBeInTheDocument();
    // #9 — untrusted backend copy never becomes markup or a link target.
    expect(section.querySelector('a')).toBeNull();
  });

  it('offers the one canonical drill-through and closes the popover with it', async () => {
    const navigate = vi.fn();
    render(<NotificationBell onNavigate={navigate} healthDegradations={DEGRADED} />);
    await userEvent.click(await screen.findByRole('button', { name: /notifications/i }));

    await userEvent.click(await screen.findByRole('button', { name: /view effectiveness/i }));
    expect(navigate).toHaveBeenCalledWith('metrics', { tab: 'effectiveness' });
    expect(screen.queryByTestId('health-degradation-section')).toBeNull();
  });
});
