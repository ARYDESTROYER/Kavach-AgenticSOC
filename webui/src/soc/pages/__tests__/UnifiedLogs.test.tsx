/**
 * Logs route deep links (SPEC §10.7): `#/logs?logQuery=…&from=…&to=…&sourceId=…` opens
 * the ONE shared browser on the LINKED QUERY with exactly those bounds (absolute instants
 * read as a UTC range) and a summary above its controls — one table, never a second
 * copy; a malformed link is ignored whole (never half-applied); "Browse all logs" drops
 * it; without a link the page is the shared unified browser. Row values stay plain text
 * (#9).
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchUnifiedLogs = vi.hoisted(() => vi.fn());
vi.mock('@/soc/UnifiedLogs.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/UnifiedLogs.api')>();
  return { ...actual, fetchUnifiedLogs };
});
const navigate = vi.hoisted(() => vi.fn());
vi.mock('@/soc/router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/router')>();
  return { ...actual, useNavigateOptional: () => navigate };
});

import { RouterProvider } from '../../router';
import UnifiedLogsPage, { boundMs, parseLogsDeepLink, windowLabel } from '../UnifiedLogs';

const NOW = Date.UTC(2026, 9, 8, 14, 0);
const RESPONSE = {
  count: 1,
  partial: false,
  limit: 150,
  truncated: false,
  sources: [{ source_id: 'wazuh-prod', source_name: 'Wazuh prod', ok: true, count: 1, mode: 'search' }],
  logs: [
    {
      id: 'e1',
      ts: '2026-10-08T13:55:00Z',
      source_id: 'wazuh-prod',
      source_name: 'Wazuh prod',
      source_ip: '203.0.113.14',
      user: 'root',
      host: 'vpn-gw-2',
      rule: 'sshd: authentication failure',
      severity: 60,
      message: '<img src=x onerror=alert(1)> Failed password for root',
      _raw: {},
    },
  ],
};

function show(hash?: string) {
  if (hash) window.location.hash = hash;
  return render(
    <RouterProvider>
      <UnifiedLogsPage />
    </RouterProvider>,
  );
}

beforeEach(() => {
  fetchUnifiedLogs.mockReset();
  fetchUnifiedLogs.mockResolvedValue(RESPONSE);
  navigate.mockClear();
});
afterEach(() => {
  window.location.hash = '';
});

describe('parseLogsDeepLink', () => {
  it('accepts the router grammar', () => {
    expect(parseLogsDeepLink({ logQuery: 'source.ip:203.0.113.14', from: 'now-24h', to: 'now', sourceId: 'wazuh-prod' }, NOW)).toEqual({
      query: 'source.ip:203.0.113.14',
      from: 'now-24h',
      to: 'now',
      sourceId: 'wazuh-prod',
    });
    expect(parseLogsDeepLink({ from: '2026-10-07T00:00:00Z', to: '2026-10-08T00:00:00Z' }, NOW)).not.toBeNull();
    expect(parseLogsDeepLink({ caseId: 'x' }, NOW)).toBeNull();
    expect(parseLogsDeepLink(undefined, NOW)).toBeNull();
  });

  it('ignores the whole link when any part is malformed or the window is wrong', () => {
    expect(parseLogsDeepLink({ logQuery: 'a\u202eb' }, NOW)).toBeNull();
    expect(parseLogsDeepLink({ logQuery: 'x', from: 'yesterday' }, NOW)).toBeNull();
    expect(parseLogsDeepLink({ logQuery: 'x', sourceId: '../etc' }, NOW)).toBeNull();
    expect(parseLogsDeepLink({ from: 'now-1h', to: 'now-2h' }, NOW)).toBeNull();
    expect(parseLogsDeepLink({ from: 'now-91d' }, NOW)).toBeNull();
    expect(parseLogsDeepLink({ logQuery: '   ' }, NOW)).toBeNull();
  });

  it('reads bounds and labels windows', () => {
    expect(boundMs('now-2h', NOW)).toBe(NOW - 7_200_000);
    expect(boundMs('garbage', NOW)).toBeNull();
    expect(windowLabel('now-24h', null)).toBe('last 24h');
    expect(windowLabel(null, null)).toBe('the default window');
  });

  it('reads absolute open_in bounds as one readable UTC range', () => {
    expect(windowLabel('2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z')).toBe('2026-10-07 00:00 → 2026-10-08 00:00 UTC');
    // The date is written once on the same day; an offset is converted to UTC.
    expect(windowLabel('2026-10-08T09:00:00Z', '2026-10-08T12:30:00+02:00')).toBe('2026-10-08 09:00 → 10:30 UTC');
    // Sub-minute bounds keep their seconds (never the raw millisecond ISO text).
    expect(windowLabel('2026-10-01T12:00:00.250Z', '2026-10-08T12:00:00.250Z')).toBe('2026-10-01 12:00:00 → 2026-10-08 12:00:00 UTC');
    expect(windowLabel('2026-10-01T12:00:00Z', null)).toBe('2026-10-01 12:00 UTC → now');
    expect(windowLabel('now-6h', '2026-10-08T12:00:00Z')).toBe('now-6h → 2026-10-08 12:00 UTC');
    expect(windowLabel(null, '2026-10-08T12:00:00Z')).toBe('until 2026-10-08 12:00 UTC');
  });
});

describe('Logs page', () => {
  it('runs the linked query with exactly its bounds and source', async () => {
    show('#/logs?logQuery=source.ip%3A203.0.113.14&from=now-24h&sourceId=wazuh-prod');
    expect(await screen.findByText('Opened from a linked query')).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchUnifiedLogs).toHaveBeenCalledWith({
        limit: 150,
        query: 'source.ip:203.0.113.14',
        from: 'now-24h',
        to: 'now',
        source_id: 'wazuh-prod',
      }),
    );
    expect(screen.getByText('source.ip:203.0.113.14')).toBeInTheDocument();
    expect(screen.getByText('last 24h')).toBeInTheDocument();
    // The shared browser starts on the linked query: its search box carries it.
    expect(screen.getByRole('textbox', { name: 'Search log events' })).toHaveValue('source.ip:203.0.113.14');
    // Untrusted message text is plain text, never markup.
    expect(await screen.findByText('<img src=x onerror=alert(1)> Failed password for root')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    // ONE table: the linked view is the shared browser, not a second copy of it.
    expect(screen.getAllByRole('table')).toHaveLength(1);
  });

  it('opens an absolute chat window with its exact bounds and a readable UTC range', async () => {
    show('#/logs?logQuery=failed&from=2026-10-01T12%3A00%3A00Z&to=2026-10-08T12%3A00%3A00.250Z');
    await waitFor(() =>
      expect(fetchUnifiedLogs).toHaveBeenCalledWith({
        limit: 150,
        query: 'failed',
        from: '2026-10-01T12:00:00Z',
        to: '2026-10-08T12:00:00.250Z',
      }),
    );
    // The summary and the time-range control both read the UTC range, not raw ISO text.
    expect(await screen.findAllByText('2026-10-01 12:00:00 → 2026-10-08 12:00:00 UTC')).not.toHaveLength(0);
    expect(screen.queryByText(/T12:00:00/)).toBeNull();
    expect(screen.getAllByRole('table')).toHaveLength(1);
  });

  it('drops the link on "Browse all logs"', async () => {
    const user = userEvent.setup();
    show('#/logs?logQuery=failed');
    await user.click(await screen.findByRole('button', { name: /Browse all logs/ }));
    expect(navigate).toHaveBeenCalledWith('logs');
    await waitFor(() => expect(screen.queryByText('Opened from a linked query')).toBeNull());
    // The shared browser takes over (its default window, no linked filter).
    await waitFor(() => expect(fetchUnifiedLogs).toHaveBeenLastCalledWith(expect.objectContaining({ from: 'now-1h', query: undefined })));
  });

  it('is the unified browser without a link', async () => {
    show('#/logs');
    expect(await screen.findByRole('heading', { level: 1, name: 'Logs' })).toBeInTheDocument();
    expect(screen.queryByText('Opened from a linked query')).toBeNull();
    await waitFor(() => expect(fetchUnifiedLogs).toHaveBeenCalledWith(expect.objectContaining({ from: 'now-1h' })));
  });

  it('reports a failed linked query without crashing', async () => {
    fetchUnifiedLogs.mockRejectedValue(new Error('Source not browsable'));
    show('#/logs?logQuery=x&sourceId=push-1');
    expect(await screen.findByText('Could not load logs')).toBeInTheDocument();
    // The summary of what was asked stays, so the analyst can see what failed.
    expect(screen.getByText('Opened from a linked query')).toBeInTheDocument();
  });
});
