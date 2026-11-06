/**
 * SourceLogsSheet — search must not refetch (or flash skeletons) on every keystroke;
 * a search fires only on Enter / Refresh (Round-6 sources finding 10).
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const sourceLogs = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { sourceLogs: (...a: unknown[]) => sourceLogs(...a) },
}));

import { SOURCE_LOG_COLUMNS, SOURCE_LOGS_SHEET_WIDTH, SourceLogsSheet } from '../SourceLogsSheet';
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
    // The mode in sentence case, never tracked capitals.
    expect(screen.getByTestId('source-logs-window')).toHaveTextContent(/^Search · most recent 1/);
    expect(screen.getByTestId('source-logs-window').innerHTML).not.toMatch(/uppercase/);
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
    // A push buffer is labelled as such: the time range and search never applied to it.
    expect(screen.getByTestId('source-logs-window')).toHaveTextContent(/^Live tail · most recent 1/);
    expect(screen.getByText(/in-memory live tail/i)).toBeInTheDocument();
  });
});

describe('SourceLogsSheet rows on the Round 14 grammar (SPEC §4.9.4, [uib] SL1 to SL3)', () => {
  const row = (id: string, ts: string, extra: Record<string, unknown> = {}) => ({
    id,
    ts,
    source_ip: '10.0.0.5',
    user: null,
    host: null,
    rule: 'auth.failed_login.very_long_rule_name_that_would_wrap',
    severity: 72,
    message: `event ${id}`,
    _raw: {},
    ...extra,
  });

  it('shows the UTC time only, one date row per day, and the full stamp in the tooltip', async () => {
    sourceLogs.mockResolvedValue({
      source_id: 'es-1',
      mode: 'search',
      count: 3,
      limit: 100,
      truncated: false,
      logs: [
        row('a', '2026-07-02T00:10:05Z'),
        row('b', '2026-07-01T23:59:01Z'),
        row('c', '2026-07-01T10:05:00Z'),
      ],
    });
    render(<SourceLogsSheet source={source} onClose={() => {}} />);
    const table = await screen.findByRole('table', { name: 'Log events' });
    expect(within(table).getByRole('columnheader', { name: 'Time (UTC)' })).toBeInTheDocument();
    const days = within(table).getAllByRole('rowheader');
    expect(days.map((d) => d.textContent)).toEqual(['Jul 2, 2026', 'Jul 1, 2026']);
    const cell = within(table).getByText('23:59:01');
    expect(cell).toHaveAttribute('title', expect.stringContaining('2026-07-01 23:59:01 UTC'));
    expect(cell.className).toMatch(/whitespace-nowrap/);
    // The rule stays on one line, the full name in its tooltip.
    const rule = within(table).getAllByText('auth.failed_login.very_long_rule_name_that_would_wrap')[0];
    expect(rule.closest('td')).toHaveClass('truncate');
  });

  it('names the severity level on the source\'s own scale, with the raw score when it is not 0 to 100 (D23, 7 of 10 reads High)', async () => {
    sourceLogs.mockResolvedValue({
      source_id: 'es-1', mode: 'search', count: 1, limit: 100, truncated: false,
      logs: [row('d', '2026-07-01T10:05:00Z', { severity: 7 })],
    });
    render(<SourceLogsSheet source={{ ...source, severity_scale_max: 10 } as SourceInstance} onClose={() => {}} />);
    const table = await screen.findByRole('table', { name: 'Log events' });
    expect(within(table).getByText(/High/)).toHaveTextContent('High (7)');
  });

  it('shows the named level only on a 0 to 100 source, the score in the tooltip', async () => {
    sourceLogs.mockResolvedValue({
      source_id: 'es-1', mode: 'search', count: 1, limit: 100, truncated: false,
      logs: [row('e', '2026-07-01T10:05:00Z', { severity: 72 })],
    });
    render(<SourceLogsSheet source={source} onClose={() => {}} />);
    const table = await screen.findByRole('table', { name: 'Log events' });
    const badge = within(table).getByText(/High/);
    expect(badge).toHaveTextContent(/^High$/);
    expect(badge.closest('[title]')).toHaveAttribute('title', 'Severity 72 on a 0 to 100 scale');
  });

  it('uses the shared refresh control and has no em dash in its copy', async () => {
    sourceLogs.mockResolvedValue({
      source_id: 'es-1', mode: 'buffer', count: 1, limit: 100, truncated: false,
      logs: [row('f', '2026-07-01T10:05:00Z')],
    });
    render(<SourceLogsSheet source={source} onClose={() => {}} />);
    await screen.findByRole('table', { name: 'Log events' });
    expect(screen.getByRole('button', { name: 'Refresh log events' })).toHaveAttribute('data-refresh-display', 'icon');
    const dialog = screen.getByRole('dialog');
    const texts: string[] = [];
    const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = (n.textContent ?? '').trim();
      if (t && t !== '—') texts.push(t);
    }
    expect(texts.filter((t) => t.includes('—'))).toEqual([]);
    expect(screen.getByRole('heading', { name: 'Logs from Prod ES' })).toBeInTheDocument();
  });
});

describe('SourceLogsSheet layout: the message gets the width (SPEC §4.9.4, [uib] SL2)', () => {
  const ROW = {
    id: 'evt-9',
    ts: '2026-07-01T10:05:00Z',
    source_ip: '10.20.23.106',
    user: null,
    host: null,
    rule: 'web_access',
    severity: 40,
    message: '10.20.23.106 - njo [01/Jul/2026] "GET /index.html HTTP/1.1" 200',
    _raw: {},
  };

  it('keeps every column but Message narrow and fixed, Message the flexible one, on a wide sheet', async () => {
    sourceLogs.mockResolvedValue({
      source_id: 'es-1', mode: 'search', count: 1, limit: 100, truncated: false, logs: [ROW],
    });
    render(<SourceLogsSheet source={source} onClose={() => {}} />);
    const table = await screen.findByRole('table', { name: 'Log events' });
    const header = (name: string) => within(table).getByRole('columnheader', { name });
    expect(header('Time (UTC)')).toHaveClass('w-[6.5rem]', 'whitespace-nowrap');
    expect(header('Source IP')).toHaveClass(SOURCE_LOG_COLUMNS.sourceIp);
    expect(header('Rule')).toHaveClass(SOURCE_LOG_COLUMNS.rule);
    expect(header('Severity')).toHaveClass(SOURCE_LOG_COLUMNS.severity);
    expect(header('Raw event')).toHaveClass('w-[2.75rem]', 'px-2');
    // Message declares no width: in a fixed table it takes everything the others leave.
    expect(header('Message').className).not.toMatch(/\bw-/);
    expect(SOURCE_LOG_COLUMNS).toEqual({
      // The header "Time (UTC)" stays on one line.
      time: 'w-[6.5rem] whitespace-nowrap',
      sourceIp: 'w-[7.5rem]',
      rule: 'w-[8rem]',
      severity: 'w-[6.5rem]',
      severityNative: 'w-[7.5rem]',
      raw: 'w-[2.75rem] px-2',
    });
    // The sheet is wider than the old 48rem so Message keeps about half the table.
    expect(screen.getByRole('dialog')).toHaveClass(SOURCE_LOGS_SHEET_WIDTH);
    expect(SOURCE_LOGS_SHEET_WIDTH).toBe('sm:max-w-5xl');
  });

  it('widens the severity column only on a native (non 0 to 100) scale', async () => {
    sourceLogs.mockResolvedValue({
      source_id: 'es-1', mode: 'search', count: 1, limit: 100, truncated: false, logs: [{ ...ROW, severity: 7 }],
    });
    render(<SourceLogsSheet source={{ ...source, severity_scale_max: 10 } as SourceInstance} onClose={() => {}} />);
    const table = await screen.findByRole('table', { name: 'Log events' });
    expect(within(table).getByRole('columnheader', { name: 'Severity' })).toHaveClass(SOURCE_LOG_COLUMNS.severityNative);
  });

  it("hands the host's focus-return handler to the sheet, so closing it can restore focus", async () => {
    const onCloseAutoFocus = vi.fn();
    function Host() {
      const [open, setOpen] = React.useState(true);
      return (
        <SourceLogsSheet
          source={open ? source : null}
          onClose={() => setOpen(false)}
          onCloseAutoFocus={onCloseAutoFocus}
        />
      );
    }
    render(<Host />);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(onCloseAutoFocus).toHaveBeenCalled());
  });
});
