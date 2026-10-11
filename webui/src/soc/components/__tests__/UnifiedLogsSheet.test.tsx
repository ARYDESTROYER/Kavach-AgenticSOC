/**
 * UnifiedLogs (Round 4 Wave 5, request #3) render test.
 *
 * Mocks the co-located `UnifiedLogs.api` (the ONLY network the view uses) and asserts:
 *   1. rows merged from multiple sources render with the MANDATORY per-row SOURCE
 *      (provenance) column showing each row's source_name;
 *   2. a PARTIAL failure (one source ok, one errored) surfaces a degraded per-source
 *      status chip + a "Partial results" notice, and never blocks the ok rows;
 *   3. UNTRUSTED row text (message with markup) renders as PLAIN TEXT — no live DOM
 *      escapes the fence (#9), no dangerouslySetInnerHTML anywhere.
 *
 * Fully offline — no real network, no auth (the view itself is unauthenticated; RBAC
 * gating is the integrator's ProtectedRoute wrapper, out of this component's scope).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { fetchUnifiedLogsMock } = vi.hoisted(() => ({ fetchUnifiedLogsMock: vi.fn() }));

// Co-located API — the component imports this named export.
vi.mock('@/soc/UnifiedLogs.api', async () => {
  const actual = await vi.importActual<typeof import('../../UnifiedLogs.api')>(
    '../../UnifiedLogs.api',
  );
  return { ...actual, fetchUnifiedLogs: fetchUnifiedLogsMock };
});

import { UnifiedLogsBody, UnifiedLogsView } from '../UnifiedLogsSheet';
import type { UnifiedLogsResponse } from '../../UnifiedLogs.api';

const RESPONSE: UnifiedLogsResponse = {
  count: 2,
  partial: true,
  limit: 150,
  truncated: false,
  sources: [
    {
      source_id: 'src-elastic', source_name: 'Prod Elasticsearch', ok: true, count: 2,
      mode: 'search',
    },
    {
      source_id: 'src-wazuh', source_name: 'Wazuh EDR', ok: false, count: 0,
      error: 'timeout', mode: 'buffer',
    },
  ],
  logs: [
    {
      id: 'evt-1',
      ts: '2026-07-01T10:05:00Z',
      source_id: 'src-elastic',
      source_name: 'Prod Elasticsearch',
      source_ip: '10.0.0.5',
      user: 'alice',
      host: 'web-01',
      rule: 'auth.failed_login',
      severity: 72,
      // UNTRUSTED — attacker-influenceable message with markup; must render as text.
      message: '<img src=x onerror="alert(1)"> failed login',
      _raw: { event: { action: 'login' } },
    },
    {
      id: 'evt-2',
      ts: '2026-07-01T10:04:00Z',
      source_id: 'src-elastic',
      source_name: 'Prod Elasticsearch',
      source_ip: null,
      user: null,
      host: null,
      rule: null,
      severity: 20,
      message: 'benign heartbeat',
      _raw: {},
    },
  ],
};

describe('UnifiedLogsView', () => {
  beforeEach(() => {
    fetchUnifiedLogsMock.mockReset();
    fetchUnifiedLogsMock.mockResolvedValue(RESPONSE);
  });

  it('uses the shared blocking state while the initial merged read is pending', async () => {
    fetchUnifiedLogsMock.mockReturnValue(new Promise(() => {}));
    const { container } = render(<UnifiedLogsView />);

    expect(await screen.findByRole('status', { name: 'Loading logs' })).toBeInTheDocument();
    expect(screen.getAllByTestId('console-loading-glyph')).toHaveLength(1);
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });

  it('renders merged rows with a mandatory per-row Source provenance column', async () => {
    render(<UnifiedLogsView />);

    // Both rows resolve; the merged message text is shown.
    await waitFor(() => expect(screen.getByText('benign heartbeat')).toBeInTheDocument());

    // MANDATORY Source column header.
    const table = screen.getByRole('table');
    expect(within(table).getByText('Source')).toBeInTheDocument();

    // Each row carries its source_name provenance (in the status strip AND the row).
    // At least one occurrence in the table body proves the per-row provenance column.
    const provenanceCells = within(table).getAllByText('Prod Elasticsearch');
    expect(provenanceCells.length).toBeGreaterThan(0);

    // The endpoint was hit with a merged read (limit + to:'now'); no source id in path.
    expect(fetchUnifiedLogsMock).toHaveBeenCalled();
    const arg = fetchUnifiedLogsMock.mock.calls[0][0];
    expect(arg).toMatchObject({ to: 'now' });
    expect(typeof arg.limit).toBe('number');
  });

  it('surfaces partial failure as a degraded per-source chip + notice, without blocking ok rows', async () => {
    render(<UnifiedLogsView />);

    await waitFor(() => expect(screen.getByText('benign heartbeat')).toBeInTheDocument());

    // Per-source status strip shows the failed source by name.
    const strip = screen.getByTestId('unified-source-status');
    expect(within(strip).getByText('Wazuh EDR')).toBeInTheDocument();

    // Partial-results notice is shown.
    expect(screen.getByText('Partial results')).toBeInTheDocument();

    // The ok source's rows are still rendered (failure did not block them).
    expect(screen.getByText('benign heartbeat')).toBeInTheDocument();
  });

  it('renders untrusted message text as plain text (no live DOM escapes the fence, #9)', async () => {
    const { container } = render(<UnifiedLogsView />);

    // The raw markup string appears verbatim as text content...
    await waitFor(() =>
      expect(screen.getByText('<img src=x onerror="alert(1)"> failed login')).toBeInTheDocument(),
    );
    // ...and NO actual <img> element was injected from the message body.
    expect(container.querySelector('img')).toBeNull();
  });

  it('reports how each source was read so a buffer is never mistaken for a search', async () => {
    render(<UnifiedLogsView />);

    const strip = await screen.findByTestId('unified-source-status');
    // The server-reported mode is visible per source; a push live-tail ring is labelled
    // as such because the time range + search box never applied to it.
    expect(within(strip).getByText('search')).toBeInTheDocument();
    expect(within(strip).getByText('live tail')).toBeInTheDocument();
  });

  it('exposes the live-tail caveat as visible text instead of a hover-only title', async () => {
    render(<UnifiedLogsView />);

    const strip = await screen.findByTestId('unified-source-status');
    // Reachable with no pointer and no focusable element: the operationally load-bearing
    // caveat is rendered text, so keyboard and screen-reader users receive it too.
    const caveat = within(strip).getByTestId('unified-buffer-caveat');
    expect(caveat).toHaveTextContent('Wazuh EDR');
    expect(caveat).toHaveTextContent(/the time range and search box do not apply/i);
    expect(caveat).toHaveTextContent(/does not survive a backend restart/i);
    expect(caveat).not.toHaveAttribute('aria-hidden');

    // The badge's own AA-tuned `-text` token carries the mode marker and the count; an
    // opacity modifier would composite 12px text below 4.5:1 in the light theme.
    expect(within(strip).getByText('live tail').className).not.toMatch(/\bopacity-/);
    expect(within(strip).getByText('search').className).not.toMatch(/\bopacity-/);
    expect(within(strip).getByText('2').className).not.toMatch(/\bopacity-/);
  });

  it('omits the live-tail caveat when every source was read by search', async () => {
    fetchUnifiedLogsMock.mockResolvedValue({
      ...RESPONSE,
      sources: RESPONSE.sources.map((s) => ({ ...s, mode: 'search' })),
    });
    render(<UnifiedLogsView />);

    const strip = await screen.findByTestId('unified-source-status');
    expect(within(strip).queryByTestId('unified-buffer-caveat')).toBeNull();
  });

  it('states the bound honestly ("most recent N", and says when more exist)', async () => {
    render(<UnifiedLogsView />);
    // Not truncated → no "more exist" claim, but the count is still framed as a window.
    await waitFor(() => expect(screen.getByText(/Most recent/i)).toBeInTheDocument());
    expect(screen.queryByText('(more exist)')).toBeNull();

    fetchUnifiedLogsMock.mockResolvedValue({ ...RESPONSE, truncated: true });
    render(<UnifiedLogsView />);
    await waitFor(() => expect(screen.getAllByText('(more exist)').length).toBeGreaterThan(0));
  });

  it('passes an optional single-source scope straight through to GET /api/logs', async () => {
    // The query type carries `source_id`; the builder must forward it untouched so the
    // server (not the client) decides what is browsable.
    const { fetchUnifiedLogs } = await vi.importActual<
      typeof import('../../UnifiedLogs.api')
    >('../../UnifiedLogs.api');
    const apiMod = await import('@/lib/api');
    const spy = vi.spyOn(apiMod.api, 'get').mockResolvedValue(RESPONSE);
    await fetchUnifiedLogs({ limit: 10, source_id: 'src-elastic' });
    expect(spy).toHaveBeenCalledWith('logs', { limit: 10, source_id: 'src-elastic' });
    spy.mockRestore();
  });

  it('shows an empty state when no browse-capable sources are enabled', async () => {
    fetchUnifiedLogsMock.mockResolvedValue({ count: 0, partial: false, sources: [], logs: [] });
    render(<UnifiedLogsView />);

    await waitFor(() =>
      expect(
        screen.getByText(/No browse-capable sources are enabled/i),
      ).toBeInTheDocument(),
    );
  });
});

describe('UnifiedLogsBody — a starting query, window and source (the Logs deep link)', () => {
  beforeEach(() => {
    fetchUnifiedLogsMock.mockReset();
    fetchUnifiedLogsMock.mockResolvedValue(RESPONSE);
  });

  it('reads the exact linked bounds and source once, with the header above ONE table', async () => {
    render(
      <UnifiedLogsBody
        initialQuery="failed"
        initialFrom="2026-10-01T12:00:00Z"
        initialTo="2026-10-08T12:00:00.250Z"
        initialWindowLabel="2026-10-01 12:00:00 → 2026-10-08 12:00:00 UTC"
        sourceId="src-elastic"
        header={<p>Linked summary</p>}
      />,
    );
    await waitFor(() => expect(screen.getByText('benign heartbeat')).toBeInTheDocument());
    expect(fetchUnifiedLogsMock).toHaveBeenCalledTimes(1);
    expect(fetchUnifiedLogsMock).toHaveBeenCalledWith({
      limit: 150,
      query: 'failed',
      from: '2026-10-01T12:00:00Z',
      to: '2026-10-08T12:00:00.250Z',
      source_id: 'src-elastic',
    });
    expect(screen.getByRole('textbox', { name: 'Search log events' })).toHaveValue('failed');
    // The one-off window reads as its label in the time-range control.
    expect(screen.getByRole('combobox', { name: 'Time range' })).toHaveTextContent('2026-10-01 12:00:00 → 2026-10-08 12:00:00 UTC');
    expect(screen.getByText('Linked summary')).toBeInTheDocument();
    expect(screen.getAllByRole('table')).toHaveLength(1);
  });

  it('selects the matching preset for an open-ended relative window', async () => {
    render(<UnifiedLogsBody initialFrom="now-24h" />);
    await waitFor(() => expect(fetchUnifiedLogsMock).toHaveBeenCalledWith(expect.objectContaining({ from: 'now-24h', to: 'now' })));
    expect(screen.getByRole('combobox', { name: 'Time range' })).toHaveTextContent('Last 24 hours');
    expect(fetchUnifiedLogsMock.mock.calls[0][0]).not.toHaveProperty('source_id');
  });
});

describe('UnifiedLogsBody — repeated event ids', () => {
  const twice = {
    ...RESPONSE,
    partial: false,
    count: 3,
    logs: [
      { ...RESPONSE.logs[1], message: 'first copy' },
      { ...RESPONSE.logs[1], ts: '2026-07-01T10:03:00Z', message: 'second copy' },
      { ...RESPONSE.logs[1], source_id: 'src-wazuh', source_name: 'Wazuh EDR', message: 'other source' },
    ],
  } satisfies UnifiedLogsResponse;

  it('renders both copies and expands only the one asked for', async () => {
    fetchUnifiedLogsMock.mockReset();
    fetchUnifiedLogsMock.mockResolvedValue(twice);
    const errors = vi.spyOn(console, 'error');
    render(<UnifiedLogsBody />);
    await waitFor(() => expect(screen.getByText('second copy')).toBeInTheDocument());
    expect(screen.getByText('first copy')).toBeInTheDocument();
    // React reports a duplicate key through console.error.
    expect(errors).not.toHaveBeenCalled();
    const toggles = screen.getAllByRole('button', { name: 'Show raw event for evt-2' });
    expect(toggles).toHaveLength(3);
    fireEvent.click(toggles[1]);
    expect(screen.getAllByTestId('ulog-row-detail')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Hide raw event for evt-2' })).toHaveLength(1);
    errors.mockRestore();
  });

  it('keeps the expanded row open when a refresh adds a newer copy of its id above it', async () => {
    const older = { ...RESPONSE.logs[1], ts: '2026-07-01T10:04:00Z', message: 'older copy', _raw: { m: 'older copy' } };
    const newer = { ...RESPONSE.logs[1], ts: '2026-07-01T10:09:00Z', message: 'newer copy', _raw: { m: 'newer copy' } };
    fetchUnifiedLogsMock.mockReset();
    fetchUnifiedLogsMock.mockResolvedValueOnce({ ...RESPONSE, partial: false, count: 1, logs: [older] });
    render(<UnifiedLogsBody />);
    await waitFor(() => expect(screen.getByText('older copy')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Show raw event for evt-2' }));
    expect(screen.getByTestId('ulog-row-detail')).toHaveTextContent('older copy');

    fetchUnifiedLogsMock.mockResolvedValueOnce({ ...RESPONSE, partial: false, count: 2, logs: [newer, older] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh log events' }));
    await waitFor(() => expect(screen.getByText('newer copy')).toBeInTheDocument());
    // The open detail is still the row the analyst expanded; the new row is closed.
    const details = screen.getAllByTestId('ulog-row-detail');
    expect(details).toHaveLength(1);
    expect(details[0]).toHaveTextContent('older copy');
    expect(details[0]).not.toHaveTextContent('newer copy');
    const toggles = screen.getAllByRole('button', { name: /raw event for evt-2/ });
    expect(toggles.map((t) => t.getAttribute('aria-expanded'))).toEqual(['false', 'true']);
  });
});
