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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { fetchUnifiedLogsMock } = vi.hoisted(() => ({ fetchUnifiedLogsMock: vi.fn() }));

// Co-located API — the component imports this named export.
vi.mock('@/soc/UnifiedLogs.api', async () => {
  const actual = await vi.importActual<typeof import('../../UnifiedLogs.api')>(
    '../../UnifiedLogs.api',
  );
  return { ...actual, fetchUnifiedLogs: fetchUnifiedLogsMock };
});

import { api } from '@/lib/api';
import type { SourceInstance } from '@/lib/types';
import { UnifiedLogsBody, UnifiedLogsView, severityCeiling, sourceErrorText } from '../UnifiedLogsSheet';
import type { UnifiedLogsResponse } from '../../UnifiedLogs.api';

/** The configured sources' list (`GET /api/sources`): each one's declared severity ceiling. */
function mockConfiguredSources(sources: Array<Partial<SourceInstance>>) {
  return vi.spyOn(api, 'listSources').mockResolvedValue({ sources: sources as SourceInstance[] });
}

const PHONE = '(max-width: 767.98px)';
function mockViewport(phone: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: phone && query === PHONE,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

beforeEach(() => {
  // No test reads the real configured-sources list (every severity reads on 0 to 100).
  mockConfiguredSources([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

  it('names only the read path that changes the meaning ("live tail"), never the raw "search" token', async () => {
    render(<UnifiedLogsView />);

    const strip = await screen.findByTestId('unified-source-status');
    // A push live-tail ring is labelled as such because the time range and search box
    // never applied to it; an ordinary search is the default and needs no word.
    expect(within(strip).getByText('live tail')).toBeInTheDocument();
    expect(strip).not.toHaveTextContent(/\bsearch\b(?! box)/);
    expect(within(strip).getByText('Prod Elasticsearch').closest('li')).toHaveTextContent(/^Prod Elasticsearch 2$/);
  });

  it("says why a source was not read as visible text, not in a tooltip", async () => {
    render(<UnifiedLogsView />);
    const strip = await screen.findByTestId('unified-source-status');
    const failed = within(strip).getByTestId('unified-source-error');
    expect(failed).toHaveTextContent('not read: timed out');
    expect(failed.closest('li')).not.toHaveAttribute('title');
    expect(sourceErrorText('error')).toBe('the read failed');
    expect(sourceErrorText('Connection refused by host')).toBe('Connection refused by host');
    expect(sourceErrorText('x'.repeat(400))).toHaveLength(160);
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

  it('states the bound honestly ("Latest N events from M sources", and says when more match)', async () => {
    const view = render(<UnifiedLogsView />);
    // Not truncated: no "more match" claim, but the count is still framed as the latest.
    const events = await screen.findByRole('region', { name: /^Latest \d+ events?$/ });
    // "from 2 sources", or "from 1 of 2 sources" when one could not be read.
    expect(events).toHaveTextContent(/from (\d+ of )?\d+ sources?/);
    expect(within(events).queryByTestId('unified-cap-note')).toBeNull();
    view.unmount();

    fetchUnifiedLogsMock.mockResolvedValue({ ...RESPONSE, truncated: true });
    render(<UnifiedLogsView />);
    // Visible text (keyboard and screen-reader users get it), not a hover-only title.
    const note = await screen.findByTestId('unified-cap-note');
    expect(note).toHaveTextContent('More events match than these 2. Narrow the time range or search to see the rest.');
    expect(note).not.toHaveAttribute('title');
  });

  it('reads like the Overview (Round 14): the page header holds the range and Refresh, rows show the time in UTC and the short source name', async () => {
    render(<UnifiedLogsView />);
    await waitFor(() => expect(screen.getByText('benign heartbeat')).toBeInTheDocument());
    const h1 = screen.getByRole('heading', { level: 1, name: 'Logs' });
    const header = h1.closest('[data-page-header]') as HTMLElement;
    const controls = header.querySelector('[data-page-header-controls]') as HTMLElement;
    expect(within(controls).getByRole('button', { name: 'Time range: Last 1 hour' })).toBeInTheDocument();
    expect(within(controls).getByRole('combobox', { name: 'Auto-refresh interval: Off' })).toBeInTheDocument();
    expect(within(controls).getByRole('button', { name: 'Refresh log events' })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'About Logs' })).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Time (UTC)' })).toBeInTheDocument();
    // The time only, on one line; the date is the group row above.
    expect(within(table).getByText('10:04:00')).toHaveAttribute('title');
    expect(within(table).getByTestId('ulog-day')).toHaveTextContent('Wed, Jul 1, 2026');
    // The named level only; the raw score and its scale are in the tooltip.
    const heartbeatRow = within(table).getByText('benign heartbeat').closest('tr') as HTMLElement;
    expect(heartbeatRow.querySelector('[title="Score 20 on a 0 to 100 scale"]')).not.toBeNull();
    expect(heartbeatRow).not.toHaveTextContent('(20)');
    // The header label stays on one line in its widened column.
    expect(within(table).getByRole('columnheader', { name: 'Time (UTC)' }).className).toMatch(/\bwhitespace-nowrap\b/);
  });

  it("reads a pull source's native severity on the ceiling it declares (Wazuh 0 to 16)", async () => {
    mockConfiguredSources([
      { id: 'wazuh-prod', display_name: 'Wazuh prod', severity_scale_max: 16 },
      // A push source's ring already holds the canonical score: its ceiling never applies.
      { id: 'hec', display_name: 'Splunk HEC', severity_scale_max: 10 },
    ]);
    fetchUnifiedLogsMock.mockResolvedValue({
      count: 3,
      partial: false,
      sources: [
        { source_id: 'wazuh-prod', source_name: 'Wazuh prod', ok: true, count: 2, mode: 'search' },
        { source_id: 'hec', source_name: 'Splunk HEC', ok: true, count: 1, mode: 'buffer' },
      ],
      logs: [
        { ...RESPONSE.logs[1], id: 'w-12', source_id: 'wazuh-prod', source_name: 'Wazuh prod', severity: 12, message: 'level twelve' },
        { ...RESPONSE.logs[1], id: 'w-10', source_id: 'wazuh-prod', source_name: 'Wazuh prod', severity: 10, message: 'level ten' },
        { ...RESPONSE.logs[1], id: 'h-9', source_id: 'hec', source_name: 'Splunk HEC', severity: 9, message: 'pushed nine' },
      ],
    } satisfies UnifiedLogsResponse);
    render(<UnifiedLogsView />);
    const table = await screen.findByRole('table');
    await waitFor(() => expect(within(table).getByText('level twelve')).toBeInTheDocument());
    const row = (text: string) => within(table).getByText(text).closest('tr') as HTMLElement;
    expect(row('level twelve')).toHaveTextContent('Critical');
    expect(row('level twelve').querySelector('[title="Score 12 on a 0 to 16 scale"]')).not.toBeNull();
    expect(row('level ten')).toHaveTextContent('High');
    expect(row('pushed nine')).toHaveTextContent('Low');
    expect(row('pushed nine').querySelector('[title="Score 9 on a 0 to 100 scale"]')).not.toBeNull();
  });

  it('keeps the canonical scale when the configured sources cannot be read', async () => {
    vi.spyOn(api, 'listSources').mockRejectedValue(new Error('forbidden'));
    fetchUnifiedLogsMock.mockResolvedValue({
      ...RESPONSE,
      partial: false,
      sources: [{ source_id: 'src-elastic', source_name: 'Prod Elasticsearch', ok: true, count: 1, mode: 'search' }],
      logs: [{ ...RESPONSE.logs[1], severity: 12 }],
    });
    render(<UnifiedLogsView />);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('benign heartbeat').closest('tr')).toHaveTextContent('Low');
  });

  it('pins the Raw event column at the right edge and fades the edge while more columns scroll', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(1088);
    const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(992);
    render(<UnifiedLogsView />);
    const table = await screen.findByRole('table');
    await waitFor(() => expect(within(table).getByText('benign heartbeat')).toBeInTheDocument());
    const head = within(table).getByRole('columnheader', { name: 'Raw event' });
    expect(head.className).toMatch(/\bsticky\b.*\bright-0\b/);
    const toggle = within(table).getAllByRole('button', { name: /^Show raw event for / })[0];
    expect(toggle.closest('td')?.className).toMatch(/\bsticky\b.*\bright-0\b/);
    // The 28px target stays out of the row's flow (compact rows).
    expect(toggle.className).toMatch(/-my-1/);
    expect(await screen.findByTestId('unified-logs-fade-right')).toHaveAttribute('aria-hidden', 'true');
    width.mockRestore();
    client.mockRestore();
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
    expect(screen.getByRole('button', { name: 'Time range: 2026-10-01 12:00:00 → 2026-10-08 12:00:00 UTC' })).toBeInTheDocument();
    expect(screen.getByText('Linked summary')).toBeInTheDocument();
    expect(screen.getAllByRole('table')).toHaveLength(1);
  });

  it('selects the matching preset for an open-ended relative window', async () => {
    render(<UnifiedLogsBody initialFrom="now-24h" />);
    await waitFor(() => expect(fetchUnifiedLogsMock).toHaveBeenCalledWith(expect.objectContaining({ from: 'now-24h', to: 'now' })));
    expect(screen.getByRole('button', { name: 'Time range: Last 24 hours' })).toBeInTheDocument();
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

describe('UnifiedLogsView at phone width (below 768px)', () => {
  beforeEach(() => {
    fetchUnifiedLogsMock.mockReset();
    fetchUnifiedLogsMock.mockResolvedValue(RESPONSE);
    mockViewport(true);
  });

  it('stacks each event as a list row with the time, source, level and message, and a 44px Raw event toggle', async () => {
    render(<UnifiedLogsView />);
    const list = await screen.findByRole('list', { name: 'Events on Wed, Jul 1, 2026' });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByTestId('ulog-day')).toHaveTextContent('Wed, Jul 1, 2026');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveTextContent('10:04:00');
    expect(rows[1]).toHaveTextContent('Prod Elasticsearch');
    expect(rows[1]).toHaveTextContent('Low');
    expect(rows[1]).toHaveTextContent('benign heartbeat');
    const toggle = within(rows[1]).getByRole('button', { name: 'Show raw event for evt-2' });
    expect(toggle.className).toMatch(/\bsize-11\b/);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(within(rows[1]).getByRole('button', { name: 'Hide raw event for evt-2' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(rows[1]).getByTestId('ulog-row-detail')).toHaveTextContent('Raw event · Prod Elasticsearch');
  });

  it('gives the search a short placeholder', async () => {
    render(<UnifiedLogsView />);
    await screen.findByRole('list', { name: /^Events on / });
    expect(screen.getByRole('textbox', { name: 'Search log events' })).toHaveAttribute('placeholder', 'Search logs');
  });
});

describe('severityCeiling', () => {
  const declared = new Map([['wazuh', 16]]);
  it('reads a search source on its declared ceiling and everything else on the canonical score', () => {
    expect(severityCeiling({ source_id: 'wazuh', mode: 'search' }, declared)).toBe(16);
    expect(severityCeiling({ source_id: 'wazuh', mode: 'buffer' }, declared)).toBe(100);
    expect(severityCeiling({ source_id: 'demo-edr', mode: 'search' }, declared)).toBe(100);
    expect(severityCeiling(undefined, declared)).toBe(100);
  });
});
