/**
 * SourceLogsSheet — search must not refetch (or flash skeletons) on every keystroke;
 * a search fires only on Enter / Refresh (Round-6 sources finding 10).
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const sourceLogs = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { sourceLogs: (...a: unknown[]) => sourceLogs(...a) },
}));

import { SourceLogsSheet } from '../SourceLogsSheet';
import type { SourceInstance } from '@/lib/types';

const source = {
  id: 'es-1',
  source_type: 'elasticsearch',
  display_name: 'Prod ES',
  ingest_mode: 'pull',
  enabled: true,
  is_primary: true,
  config: {},
} as unknown as SourceInstance;

beforeEach(() => {
  sourceLogs.mockReset().mockResolvedValue({ source_id: 'es-1', mode: 'search', count: 0, logs: [] });
});

describe('SourceLogsSheet search (finding 10)', () => {
  it('does not fire a request while typing — only Enter runs the search', async () => {
    render(<SourceLogsSheet source={source} onClose={() => {}} />);

    // The initial auto-load has settled.
    await waitFor(() => expect(sourceLogs).toHaveBeenCalled());
    const afterLoad = sourceLogs.mock.calls.length;

    const input = await screen.findByLabelText('Search log events');
    fireEvent.change(input, { target: { value: 'failure' } });
    fireEvent.change(input, { target: { value: 'failure login' } });

    // Typing must NOT trigger any additional fetches.
    expect(sourceLogs.mock.calls.length).toBe(afterLoad);

    // Enter runs a single search, carrying the typed query.
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(sourceLogs.mock.calls.length).toBe(afterLoad + 1));
    const [, params] = sourceLogs.mock.calls[afterLoad];
    expect(params).toMatchObject({ query: 'failure login' });
  });
});

describe('SourceLogsSheet bound honesty', () => {
  const ROW = {
    id: 'evt-1',
    ts: '2026-07-01T10:05:00Z',
    source_ip: '10.0.0.5',
    user: 'alice',
    host: 'web-01',
    rule: 'auth.failed_login',
    severity: 72,
    // UNTRUSTED — attacker-influenceable message with markup; must render as text.
    message: '<img src=x onerror="alert(1)"> failed login',
    _raw: { event: { action: 'login' } },
  };

  it('frames the window as "most recent N" and flags a truncated read', async () => {
    sourceLogs.mockResolvedValue({
      source_id: 'es-1', mode: 'search', count: 1, total: 9000,
      limit: 100, truncated: true, logs: [ROW],
    });
    const { container } = render(<SourceLogsSheet source={source} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/most\s*recent/i)).toBeInTheDocument());
    // Browse has no pagination, so a capped read says so instead of implying completeness.
    expect(screen.getByText('(more exist)')).toBeInTheDocument();
    expect(screen.getByText('search')).toBeInTheDocument();
    // #9: the untrusted message is text, never live markup.
    expect(
      screen.getByText('<img src=x onerror="alert(1)"> failed login'),
    ).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('omits the "more exist" claim when nothing was demonstrably cut', async () => {
    sourceLogs.mockResolvedValue({
      source_id: 'wh-1', mode: 'buffer', count: 1, limit: 100, truncated: false, logs: [ROW],
    });
    render(<SourceLogsSheet source={source} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/most\s*recent/i)).toBeInTheDocument());
    expect(screen.queryByText('(more exist)')).toBeNull();
    // A push buffer is labelled as such — the time range/search never applied to it.
    expect(screen.getByText('buffer')).toBeInTheDocument();
    expect(screen.getByText(/in-memory live tail/i)).toBeInTheDocument();
  });
});
