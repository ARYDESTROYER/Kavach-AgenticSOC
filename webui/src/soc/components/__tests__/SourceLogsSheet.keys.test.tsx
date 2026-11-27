/**
 * SourceLogsSheet: a source that returns one event id for several rows (Demo Mode's
 * QRadar feed) renders every row once, without React's duplicate-key warning, and one
 * click on "Show raw event" opens only that row.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const sourceLogs = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { sourceLogs: (...a: unknown[]) => sourceLogs(...a) },
}));

import { SourceLogsSheet } from '../SourceLogsSheet';
import type { SourceInstance } from '@/lib/types';

const source = {
  id: 'demo-qradar',
  source_type: 'qradar',
  display_name: 'IBM QRadar SIEM',
  ingest_mode: 'push',
  enabled: true,
  is_primary: false,
  config: {},
} as unknown as SourceInstance;

const event = (ts: string, message: string) => ({
  id: 'LP-QR-0001',
  ts,
  source_ip: '10.0.0.5',
  user: null,
  host: null,
  rule: 'qradar.offense',
  severity: 40,
  message,
  _raw: { m: message },
});

describe('SourceLogsSheet repeated event ids', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    sourceLogs.mockReset();
    errors = vi.spyOn(console, 'error');
  });
  afterEach(() => errors.mockRestore());

  it('renders every row once and expands only the row clicked', async () => {
    sourceLogs.mockResolvedValue({
      source_id: 'demo-qradar', mode: 'buffer', count: 3,
      logs: [event('2026-07-01T10:03:00Z', 'third'), event('2026-07-01T10:02:00Z', 'second'),
        event('2026-07-01T10:02:00Z', 'second again')],
    });
    render(<SourceLogsSheet source={source} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('second again')).toBeInTheDocument());
    // React reports a duplicate key through console.error.
    expect(errors).not.toHaveBeenCalled();

    const toggles = screen.getAllByRole('button', { name: 'Show raw event for LP-QR-0001' });
    expect(toggles).toHaveLength(3);
    fireEvent.click(toggles[1]);
    expect(screen.getAllByRole('button', { name: 'Hide raw event for LP-QR-0001' })).toHaveLength(1);
    expect(toggles.map((t) => t.getAttribute('aria-expanded'))).toEqual(['false', 'true', 'false']);
    expect(screen.getAllByText(/"m": "second"/)).toHaveLength(1);
  });

  it('keeps the expanded row open when a refresh adds a newer event with the same id', async () => {
    sourceLogs.mockResolvedValueOnce({
      source_id: 'demo-qradar', mode: 'buffer', count: 1, logs: [event('2026-07-01T10:02:00Z', 'older')],
    });
    render(<SourceLogsSheet source={source} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('older')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Show raw event for LP-QR-0001' }));

    sourceLogs.mockResolvedValueOnce({
      source_id: 'demo-qradar', mode: 'buffer', count: 2,
      logs: [event('2026-07-01T10:05:00Z', 'newer'), event('2026-07-01T10:02:00Z', 'older')],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh log events' }));
    await waitFor(() => expect(screen.getByText('newer')).toBeInTheDocument());
    const toggles = screen.getAllByRole('button', { name: /raw event for LP-QR-0001/ });
    expect(toggles.map((t) => t.getAttribute('aria-expanded'))).toEqual(['false', 'true']);
    expect(screen.queryByText(/"m": "newer"/)).toBeNull();
    expect(screen.getByText(/"m": "older"/)).toBeInTheDocument();
    expect(errors).not.toHaveBeenCalled();
  });
});
